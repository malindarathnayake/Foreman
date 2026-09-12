/**
 * Brief preflight (0.6.20). Field report 2026-09-10: preflight was an attestation the
 * pit-boss typed, and three of four unit defects were brief omissions that a worker
 * implemented faithfully. Nothing compared the brief against the spec before the attempt.
 *
 * These are the mechanical checks. Two refuse: a symbol the brief claims to have grepped
 * that is not in the spec, and a citation in the brief that does not resolve in the repo
 * (checked by verifyCitations in the tool). The rest advise: directive sentences with no
 * echo in the brief, contradiction markers, and files that reference a type the unit
 * extends but are outside its declared Files. A crude check that is honest about being
 * crude beats an attestation, and the receipt makes the check something the pit-boss
 * cannot type: the ledger refuses a delegation whose brief hash has no preflight record.
 *
 * Pure functions over text and a directory walk. No ledger access.
 */
import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { PREFLIGHT_FILE } from "./foremanFiles.js"
import { appendFileDurable } from "./atomicWrite.js"
import type { ForwardObligation } from "../types.js"

export { PREFLIGHT_FILE }
export const PREFLIGHT_POLICY_VERSION = 1 as const
const SIGNIFICANT_MIN = 4
const COVER_RATIO = 0.5
const MAX_SENTENCES = 200

// ─── Directive coverage ──────────────────────────────────────────────────────

const STOP = new Set(["that", "this", "with", "from", "into", "must", "will", "should", "when", "then", "than", "them", "they", "each", "every", "only", "also", "have", "been", "being", "were", "your", "their", "there", "where", "which", "while", "after", "before", "about", "above", "below", "under", "over", "does", "done", "make", "made", "such", "same", "some", "more", "most", "less", "least", "very", "just", "unit", "units", "file", "files", "code"])

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
}

function significantWords(text: string): string[] {
  return [...new Set(
    text.toLowerCase().replace(/`[^`\n]*`/g, " ").match(/[a-z][a-z0-9_.-]*/g)?.filter((w) => w.length >= SIGNIFICANT_MIN && !STOP.has(w)) ?? []
  )]
}

/** Split a directive into sentence-sized units: bullets, table rows and sentences. */
export function directiveSentences(directive: string): string[] {
  const out: string[] = []
  for (const rawLine of directive.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*+]|\d+[.)]|\|)\s*/, "").trim()
    if (!line || /^#+\s/.test(rawLine) || /^\|?\s*-{3,}/.test(line)) continue
    for (const s of line.split(/(?<=[.;!?])\s+(?=[A-Z`(])/)) {
      const t = s.trim()
      if (t.length >= 12) out.push(t)
    }
  }
  return out.slice(0, MAX_SENTENCES)
}

export interface CoverageReport {
  sentences: number
  uncovered: string[]
  /** 0..1, covered sentences over all sentences; 1 when the directive is empty. */
  ratio: number
}

/**
 * A directive sentence is covered when every code span it names appears in the brief and
 * at least half of its significant words do. Lexical, not semantic: a paraphrase that drops
 * the identifiers is reported, which is the omission class the field report hit.
 */
export function directiveCoverage(directive: string, brief: string): CoverageReport {
  const briefLower = brief.toLowerCase()
  const briefWords = new Set(significantWords(brief))
  const sentences = directiveSentences(directive)
  const uncovered: string[] = []
  for (const s of sentences) {
    const spans = codeSpans(s)
    const spansOk = spans.every((span) => briefLower.includes(span.toLowerCase()))
    const words = significantWords(s)
    const hit = words.filter((w) => briefWords.has(w)).length
    const wordsOk = words.length === 0 || hit / words.length >= COVER_RATIO
    if (!(spansOk && wordsOk)) uncovered.push(s)
  }
  return { sentences: sentences.length, uncovered, ratio: sentences.length === 0 ? 1 : (sentences.length - uncovered.length) / sentences.length }
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

/** Every symbol the brief claims to have grepped must appear in the spec text. */
export function missingSymbols(symbols: string[], specText: string): string[] {
  return [...new Set(symbols.map((s) => s.trim()).filter(Boolean))].filter((s) => !specText.includes(s))
}

// ─── Contradiction markers ───────────────────────────────────────────────────

export interface ConsistencyFlag {
  kind: "duplicate_rule" | "draft_marker" | "status_conflict"
  detail: string
}

/**
 * Crude, and labelled so. Catches the shapes the field report showed: the same rule number
 * defined more than once with different bodies, draft or TBD markers left in, and one
 * subject asserted with two different HTTP statuses.
 */
export function consistencyFlags(brief: string): ConsistencyFlag[] {
  const flags: ConsistencyFlag[] = []
  const rules = new Map<string, Set<string>>()
  for (const m of brief.matchAll(/\b(?:rule|step|case)\s*(\d+)\s*[:.)-]\s*([^.\n]{4,})/gi)) {
    const key = m[1]
    const body = m[2].trim().toLowerCase().replace(/\s+/g, " ")
    const set = rules.get(key) ?? new Set<string>()
    set.add(body)
    rules.set(key, set)
  }
  for (const [n, bodies] of rules) if (bodies.size > 1) flags.push({ kind: "duplicate_rule", detail: `rule ${n} is defined ${bodies.size} different ways` })
  for (const m of brief.matchAll(/\b(DRAFT|TBD|TODO|FIXME|XXX)\b/g)) {
    flags.push({ kind: "draft_marker", detail: `${m[1]} marker left in the brief` })
    if (flags.length > 20) break
  }
  const statuses = new Map<string, Set<string>>()
  for (const m of brief.matchAll(/((?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+|\/[a-z0-9_/{}:-]+)[^.\n]{0,80}?\b(?:status|returns?|respond(?:s|ed)? with|expect(?:s|ed)?)\s*(?:code\s*)?(\d{3})\b/gi)) {
    const subject = m[1].toLowerCase()
    const set = statuses.get(subject) ?? new Set<string>()
    set.add(m[2])
    statuses.set(subject, set)
  }
  for (const [subject, codes] of statuses) if (codes.size > 1) flags.push({ kind: "status_conflict", detail: `${subject} is asserted with statuses ${[...codes].join(" and ")}` })
  return flags
}

// ─── Ownership sweep ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", ".next", "coverage", "bin", "obj"])
const MAX_FILES = 5000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|cs|rb|php|swift|scala|c|cc|cpp|h|hpp)$/i

export interface OwnershipHit {
  file: string
  /** Type or member names the file references. */
  references: string[]
  /** The file switches, matches or maps over the type (a dispatch site). */
  dispatch: boolean
  /** A default arm exists: the new member falls through silently unless the file changes. */
  default_arm: boolean
  /** Members the unit introduces that this file already names. */
  members_present: string[]
  /**
   * Field feedback 2026-09-10: for a member the unit introduces, PRESENCE at a site is
   * reassurance and ABSENCE at a dispatch site with a default arm is the risk. `at_risk` =
   * dispatch site, default arm, none of the members present; `present` = at least one
   * member already named; `reference` = mentions the type, no dispatch shape.
   */
  status: "at_risk" | "present" | "reference"
}

export interface OwnershipReport {
  scanned: number
  truncated: boolean
  /** Files that reference the type or a member and are NOT in the declared Files. */
  outside: OwnershipHit[]
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

async function* walk(root: string, rel = "", state = { count: 0 }): AsyncGenerator<string> {
  let entries: import("fs").Dirent[]
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (state.count >= MAX_FILES) return
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      yield* walk(root, r, state)
    } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
      state.count += 1
      yield r
    }
  }
}

/**
 * Files outside the declared set that reference a type the unit extends or one of the
 * members it introduces. Language-blind by design: a `switch`/`match`/`case`/`map` mention
 * of the type marks a dispatch site; a `default:`/`_ =>`/`else` in the same file marks the
 * silent fall-through the field report named. Advisory: the pit-boss decides.
 */
export async function ownershipSweep(repoRoot: string, typeNames: string[], members: string[], declaredFiles: string[]): Promise<OwnershipReport> {
  const declared = new Set(declaredFiles.map(normalizePath))
  const names = [...new Set([...typeNames, ...members].map((n) => n.trim()).filter((n) => n.length >= 2))]
  const outside: OwnershipHit[] = []
  const state = { count: 0 }
  if (names.length === 0) return { scanned: 0, truncated: false, outside }
  const wordRe = (n: string) => new RegExp(`(?<![A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`)
  const nameRes = names.map((n) => [n, wordRe(n)] as const)
  const typeRes = typeNames.map((n) => wordRe(n))
  const memberRes = members.map((n) => [n, wordRe(n)] as const)
  for await (const rel of walk(repoRoot, "", state)) {
    if (declared.has(normalizePath(rel))) continue
    let text: string
    try {
      const st = await fs.stat(path.join(repoRoot, rel))
      if (st.size > MAX_FILE_BYTES) continue
      text = await fs.readFile(path.join(repoRoot, rel), "utf-8")
    } catch {
      continue
    }
    const references = nameRes.filter(([, re]) => re.test(text)).map(([n]) => n)
    if (references.length === 0) continue
    const dispatch = typeRes.some((re) => re.test(text)) && /\b(switch|match|case)\b|map\[|Record<|Map<|\bdispatch\b|\bregistry\b/.test(text)
    const default_arm = /\bdefault\s*:|_\s*=>|\belse\s*\{?\s*$/m.test(text)
    const members_present = memberRes.filter(([, re]) => re.test(text)).map(([n]) => n)
    const status: OwnershipHit["status"] = members_present.length > 0 ? "present" : dispatch && default_arm ? "at_risk" : "reference"
    outside.push({ file: normalizePath(rel), references, dispatch, default_arm, members_present, status })
    if (outside.length >= 50) break
  }
  const rank = (h: OwnershipHit) => (h.status === "at_risk" ? 0 : h.status === "reference" ? 1 : 2)
  outside.sort((a, b) => rank(a) - rank(b) || Number(b.dispatch) - Number(a.dispatch) || a.file.localeCompare(b.file))
  return { scanned: state.count, truncated: state.count >= MAX_FILES, outside }
}

// ─── The unit's directive block (moved from tools/preflightCheck in 0.6.25) ──────
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

// ─── Citations in a brief ────────────────────────────────────────────────────
// verify_citations reads a spec's evidence tables; a brief is prose. The field report hit
// three stale self-citations (a file:line that moved, a named test that does not exist), so
// the brief's own references are checked here: every `path:line` must name a file that
// exists with that line in range, and every named test identifier must appear in a source
// file under the root. Dead ones refuse the preflight; a line that moved is reported with
// the nearest match when the anchor text can be found.

export interface CitationCheck {
  raw: string
  /** 0.6.24: `test_selector` is a `-run <regex>` operand (Go semantics, first slash component). */
  kind: "file_line" | "file" | "test_name" | "test_selector"
  /** 0.6.24: `forward` = the brief orders it into existence (preflight_check `creates`); the pass verdict checks the promise. */
  status: "ok" | "dead" | "drifted" | "forward"
  detail: string
}

const FILE_REF = /(?<![\w/.-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,10})(?::(\d+)(?:-(\d+))?)?(?![\w/])/g
const TEST_NAME = /\b(Test[A-Z][A-Za-z0-9_]{3,}|test_[a-z0-9_]{4,})\b/g
/** `-run X`, `-run=X`, `-test.run X`, quoted or bare. The operand is a Go regex, not an identifier. */
const RUN_SELECTOR = /(?:^|\s)(?:-run|-test\.run)(?:=|\s+)(?:'([^']+)'|"([^"]+)"|([^\s'";,)]+))/g

export function extractCitations(brief: string): Array<{ raw: string; kind: CitationCheck["kind"]; file?: string; line?: number; name?: string }> {
  const out: Array<{ raw: string; kind: CitationCheck["kind"]; file?: string; line?: number; name?: string }> = []
  const seen = new Set<string>()
  for (const m of brief.matchAll(FILE_REF)) {
    const raw = m[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(m[2] !== undefined ? { raw, kind: "file_line", file: m[1], line: Number(m[2]) } : { raw, kind: "file", file: m[1] })
  }
  // 0.6.24 (field report): the spec's own checkpoint rows say `-run TestMapNormalises`, a
  // prefix regex, which the identifier scan below read as an unknown test. Selectors are
  // lifted out first and their span is blanked so the identifier scan does not see them.
  let scan = brief
  for (const m of brief.matchAll(RUN_SELECTOR)) {
    const operand = m[1] ?? m[2] ?? m[3]
    const raw = m[0].trim()
    scan = scan.slice(0, m.index!) + " ".repeat(m[0].length) + scan.slice(m.index! + m[0].length)
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push({ raw, kind: "test_selector", name: operand })
  }
  for (const m of scan.matchAll(TEST_NAME)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ raw: m[1], kind: "test_name", name: m[1] })
  }
  return out.slice(0, 100)
}

const GO_TEST_DECL = /^func\s+(Test[A-Za-z0-9_]*)\s*\(/gm

/** Strip line and block comments so a name mentioned in a comment is not a declaration. */
function stripComments(text: string, file: string): string {
  const py = /\.py$/i.test(file)
  return py
    ? text.replace(/#.*$/gm, "")
    : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "")
}

/**
 * True when `name` is DECLARED as a test in `text` (Go func, Python def, C#/Java/Rust
 * method or fn, or a JS/TS string-named it/test/describe). A comment, a call or a reference
 * does not count: this is what the forward-declaration promise is checked against.
 */
export function testDeclared(text: string, name: string, file = ""): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const src = stripComments(text, file)
  const forms = [
    new RegExp(`(^|\\n)\\s*func\\s+${n}\\s*\\(`),
    new RegExp(`(^|\\n)\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`),
    new RegExp(`\\b(?:void|Task|async\\s+Task|fn|def)\\s+${n}\\s*\\(`),
    new RegExp(`\\b(?:it|test|describe)(?:\\.(?:only|skip|each))?\\s*\\(\\s*["'\`]${n}["'\`]`),
  ]
  return forms.some((re) => re.test(src))
}

const TEST_FILE = /(_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(^|\/)test_[^/]*\.py|_test\.py|_spec\.rb|Tests?\.cs|Test\.java|Tests\.java)$/i

/** Normalize a `creates` list: paths forward-slashed, names deduplicated. */
export function normalizeObligations(creates: Array<{ file: string; tests?: string[] }>): ForwardObligation[] {
  const byFile = new Map<string, Set<string>>()
  for (const c of creates) {
    const f = c.file.replace(/\\/g, "/").replace(/^\.\//, "")
    const set = byFile.get(f) ?? new Set<string>()
    for (const t of c.tests ?? []) set.add(t.trim())
    byFile.set(f, set)
  }
  return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, tests]) => ({ file, tests: [...tests].sort() }))
}

/** Merge obligations carried from an earlier attempt with the new ones (a follow-up brief cannot drop a promise). */
export function mergeObligations(previous: ForwardObligation[] | undefined, next: ForwardObligation[]): ForwardObligation[] {
  return normalizeObligations([...(previous ?? []), ...next])
}

/**
 * Every promise that is not yet kept: a forward file that does not exist, or a test name not
 * declared in its file. Read from the repository root the server knows, never from the call.
 */
export async function forwardUnmet(repoRoot: string, obligations: ForwardObligation[]): Promise<string[]> {
  const unmet: string[] = []
  for (const o of obligations) {
    const abs = path.resolve(repoRoot, o.file)
    if (path.relative(repoRoot, abs).startsWith("..")) {
      unmet.push(`${o.file}: escapes the repository root`)
      continue
    }
    let text: string
    try {
      text = await fs.readFile(abs, "utf-8")
    } catch {
      unmet.push(`${o.file}: not created`)
      continue
    }
    for (const t of o.tests) {
      if (!testDeclared(text, t, o.file)) unmet.push(`${o.file}: ${t} is not declared there (a comment, call or reference does not count)`)
    }
  }
  return unmet
}

export async function checkCitations(repoRoot: string, brief: string, creates: ForwardObligation[] = []): Promise<CitationCheck[]> {
  const cites = extractCitations(brief)
  const results: CitationCheck[] = []
  const forwardFiles = new Set(creates.map((c) => c.file))
  const forwardTests = new Map<string, string>()
  for (const c of creates) for (const t of c.tests) forwardTests.set(t, c.file)
  const forwardTestFiles = creates.filter((c) => TEST_FILE.test(c.file)).map((c) => c.file)
  let sources: Map<string, string> | null = null
  const loadSources = async () => {
    if (sources) return sources
    sources = new Map()
    const state = { count: 0 }
    for await (const rel of walk(repoRoot, "", state)) {
      try {
        const st = await fs.stat(path.join(repoRoot, rel))
        if (st.size > MAX_FILE_BYTES) continue
        sources.set(rel, await fs.readFile(path.join(repoRoot, rel), "utf-8"))
      } catch {
        continue
      }
    }
    return sources
  }
  for (const c of cites) {
    if (c.kind === "test_selector") {
      // Go semantics: the operand is a regex; a slash separates subtest components, the first
      // names top-level tests. An anchored form stays anchored; a bare prefix matches longer
      // names and the matches are reported, never presented as proof the intended test ran.
      const first = c.name!.split("/")[0]
      let re: RegExp
      try {
        re = new RegExp(first)
      } catch {
        results.push({ raw: c.raw, kind: c.kind, status: "dead", detail: `'${first}' is not a valid regular expression` })
        continue
      }
      const src = await loadSources()
      const matched = new Set<string>()
      for (const [file, text] of src) {
        if (!/_test\.go$/.test(file)) continue
        for (const m of text.matchAll(GO_TEST_DECL)) if (re.test(m[1])) matched.add(m[1])
      }
      if (matched.size) {
        const names = [...matched].sort()
        results.push({ raw: c.raw, kind: c.kind, status: "ok", detail: `matches ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` (+${names.length - 6})` : ""}` })
        continue
      }
      const promised = [...forwardTests.keys()].filter((t) => re.test(t))
      results.push(promised.length
        ? { raw: c.raw, kind: c.kind, status: "forward", detail: `no declared Go test matches yet; ${promised.join(", ")} promised in ${[...new Set(promised.map((t) => forwardTests.get(t)))].join(", ")}` }
        : { raw: c.raw, kind: c.kind, status: "dead", detail: "no func Test… declaration under the root matches this selector; if the unit adds the test, name it in the preflight_check CREATES PARAMETER — creates: [{ file: \"<the test file>\", tests: [\"<the Test function name the selector matches>\"] }] — a parameter of the call, not a section of the brief" })
      continue
    }
    if (c.kind === "test_name") {
      const src = await loadSources()
      const re = new RegExp(`(?<![A-Za-z0-9_])${c.name}(?![A-Za-z0-9_])`)
      const hit = [...src.entries()].find(([, text]) => re.test(text))
      if (hit) {
        results.push({ raw: c.raw, kind: c.kind, status: "ok", detail: `defined or referenced in ${hit[0]}` })
      } else if (forwardTests.has(c.name!)) {
        results.push({ raw: c.raw, kind: c.kind, status: "forward", detail: `promised in ${forwardTests.get(c.name!)}; the pass verdict requires it declared there` })
      } else {
        results.push({ raw: c.raw, kind: c.kind, status: "dead", detail: forwardTestFiles.length
          ? `no source file under the root names this test; if the unit adds it, pass it in the preflight_check CREATES PARAMETER: creates: [{ file: "${forwardTestFiles[0]}", tests: ["${c.name}"] }] — a parameter of the call, not a section of the brief`
          : `no source file under the root names this test; if the unit adds it, pass it in the preflight_check CREATES PARAMETER: creates: [{ file: "<the test file>", tests: ["${c.name}"] }] — a parameter of the call, not a section of the brief` })
      }
      continue
    }
    const abs = path.resolve(repoRoot, c.file!)
    if (path.relative(repoRoot, abs).startsWith("..")) {
      results.push({ raw: c.raw, kind: c.kind, status: "dead", detail: "path escapes the repository root" })
      continue
    }
    let text: string
    try {
      text = await fs.readFile(abs, "utf-8")
    } catch {
      results.push(forwardFiles.has(c.file!.replace(/\\/g, "/"))
        ? { raw: c.raw, kind: c.kind, status: "forward", detail: c.kind === "file_line" ? "promised under creates; a line number on a file that does not exist yet is not checked" : "promised under creates; the pass verdict requires it to exist" }
        : { raw: c.raw, kind: c.kind, status: "dead", detail: `file not found; if the unit creates it, pass it in the preflight_check CREATES PARAMETER: creates: [{ file: "${c.raw.split(":")[0].slice(0, 120)}", tests: [] }] — a parameter of the call, not a section of the brief` })
      continue
    }
    if (c.kind === "file") {
      results.push({ raw: c.raw, kind: c.kind, status: "ok", detail: "file exists" })
      continue
    }
    const lines = text.split(/\r?\n/)
    if (c.line! >= 1 && c.line! <= lines.length) {
      results.push({ raw: c.raw, kind: c.kind, status: "ok", detail: `line ${c.line} of ${lines.length}` })
    } else {
      results.push({ raw: c.raw, kind: c.kind, status: "drifted", detail: `line ${c.line} is out of range (file has ${lines.length} lines); re-cite before the worker reads it` })
    }
  }
  return results
}

// ─── Receipt ─────────────────────────────────────────────────────────────────

/** The brief hash the ledger checks: a delegation must carry the brief a preflight record names. */
export function briefHash(brief: string): string {
  return createHash("sha256").update(brief.replace(/\r\n/g, "\n").trim(), "utf-8").digest("hex").slice(0, 16)
}

export interface PreflightRecord {
  v: typeof PREFLIGHT_POLICY_VERSION
  ts: string
  phase: string
  unit_id: string
  brief_hash: string
  status: "pass" | "fail"
  symbols: number
  coverage_ratio: number
  uncovered: number
  flags: number
  dead_citations: number
  ownership_outside: number
  /** 0.6.22: the unit's spec contract digest at preflight time; the delegation refuses when the contract moved. */
  contract_sha256?: string
  /** 0.6.24: files and tests the brief orders into existence; frozen onto the delegation, checked at the pass verdict. */
  forward?: ForwardObligation[]
  /** 0.6.25: checkpoint reach over the unit's spec Files: ok | omitted | unknown | none. */
  reach?: "ok" | "omitted" | "unknown" | "none"
  /** 0.6.25: true when reach was the ONLY failure; a delegation may consume such a record with user_override. */
  reach_only?: boolean
  checkpoint_sha256?: string
}

export function preflightPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), PREFLIGHT_FILE)
}

/** Append-only; the ledger only ever asks "does a passing record exist for this brief hash". */
export async function appendPreflight(filePath: string, record: PreflightRecord): Promise<void> {
  await appendFileDurable(filePath, JSON.stringify(record) + "\n")
}

/**
 * The NEWEST record for this brief hash decides (a later failure supersedes an earlier
 * pass), and when a unit is named only that unit's records count: a pass obtained on
 * another unit, or before a stronger check, cannot be replayed (Codex review, 2026-09-10).
 */
export async function findPreflight(filePath: string, briefHashValue: string, unitId?: string, phase?: string): Promise<PreflightRecord | null> {
  const newest = await findPreflightAny(filePath, briefHashValue, unitId, phase)
  return newest !== null && newest.status === "pass" ? newest : null
}

/** 0.6.25: the newest record whatever its status (the reach-only exception reads it). */
export async function findPreflightAny(filePath: string, briefHashValue: string, unitId?: string, phase?: string): Promise<PreflightRecord | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  let newest: PreflightRecord | null = null
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as PreflightRecord
      if (rec.brief_hash !== briefHashValue) continue
      if (unitId !== undefined && rec.unit_id !== unitId) continue
      if (phase !== undefined && rec.phase !== phase) continue
      newest = rec
    } catch {
      continue
    }
  }
  return newest
}
