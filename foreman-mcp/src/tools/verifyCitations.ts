import fs from "node:fs/promises"
import path from "node:path"
import { toKeyValue, toTable } from "../lib/toon.js"
import type { VerifyCitationsInput } from "../types.js"

// verify_citations: deterministic, read-only citation verifier.
//
// It parses evidence references (markdown `Evidence:` lines and spec.machine.json
// evidence arrays), re-reads each cited file under repo_root, and reports whether a
// verbatim anchor is present AT or near the cited line. It proves LOCATION and
// VERBATIM PRESENCE only — never that the cited line supports the claim (that is
// Layer C, out of scope). No LLM, subprocess, or network access.
//
// Evidence lines inside fenced (``` / ~~~) code blocks are treated as illustrative
// examples and are not verified.

export type Verdict =
  | "CONFIRMED"
  | "CONFIRMED_NORMALIZED"
  | "DRIFTED"
  | "UNANCHORED"
  | "ANCHOR_TOO_GENERIC"
  | "CASE_MISMATCH"
  | "MISSING"
  | "MALFORMED"
  | "AMBIGUOUS"
  | "UNDECODABLE"
  | "NON_FILE"

export interface ParsedRef {
  origin: string
  raw: string
  filePath: string | null
  startLine: number | null
  endLine: number | null
  anchor: string | null
  nonFile: boolean
  malformed: boolean
  bareCandidate: boolean
}

export interface RefVerdict {
  origin: string
  raw: string
  path: string
  line: string
  anchor: string
  verdict: Verdict
  detail: string
}

export interface VerifyCitationsResult {
  source: string
  repo_root: string
  total_refs: number
  counts: Record<string, number>
  passed: boolean
  verdicts: RefVerdict[]
}

interface Seg {
  code: boolean
  text: string
}

interface RawRef {
  origin: string
  refStr: string | null
  anchor: string | null
  malformed?: boolean
  nonFileHint?: boolean
}

const EVIDENCE_KEYS = new Set([
  "evidence",
  "specified_evidence",
  "observed_evidence",
  "spec_evidence",
  "implementation_evidence",
])
const SOURCE_KEYS = new Set(["sources", "spec_sources", "implementation_sources"])
const GENERIC_STOPWORDS = new Set([
  "return", "const", "let", "var", "if", "else", "import", "export",
  "begin", "end", "function", "class", "public", "private", "def",
  "async", "await", "new", "this", "true", "false", "null", "void",
])

const NONFILE_LABEL = /^(discovery|spec|ticket|ref|external|cmd|command|note)\b\s*:/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/
// Anchor the Evidence label to line start, a whitespace boundary, or a list marker
// so a substring like "PriorEvidence:" does not produce a spurious ref.
const EVIDENCE_LABEL = /(?:^|\s|[-*]\s*)Evidence:/
// A trailing colon followed by a structurally-broken line spec (e.g. `foo.ts:1-`,
// `foo.ts:-3`, `foo.ts:`) on a file-like token — malformed, not a real path.
const BROKEN_LINESPEC = /:(?:\d+-|\d*-\d*|-\d*|)$/
// Bound recursion into machine JSON so degenerate/hostile nesting cannot overflow
// the call stack. Real specs are a handful of levels deep.
const MAX_JSON_DEPTH = 200

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function looksLikeFile(s: string): boolean {
  if (/[/\\]/.test(s)) return true
  // Trailing-extension heuristic only on a single whitespace-free token (a bare
  // filename like `router.ts`). Prose that merely ends in a dotted token (e.g.
  // `see Node.js`, `version 1.0`) contains internal whitespace and stays NON_FILE.
  if (/^\S+\.[A-Za-z0-9]{1,12}$/.test(s)) return true
  return false
}

function parseRefToken(rawIn: string): {
  nonFile: boolean
  filePath: string | null
  startLine: number | null
  endLine: number | null
  malformed: boolean
  bareCandidate: boolean
} {
  const none = { filePath: null, startLine: null, endLine: null }
  const s = rawIn.trim().replace(/^[<"']+/, "").replace(/[>"']+$/, "").trim()
  if (!s) return { nonFile: true, ...none, malformed: false, bareCandidate: false }
  if (SCHEME.test(s) || TICKET.test(s) || NONFILE_LABEL.test(s)) {
    return { nonFile: true, ...none, malformed: false, bareCandidate: false }
  }
  // file:line:col (editor/compiler paste) — the FIRST trailing number is the line,
  // the column is ignored. Must precede the greedy single-colon rule.
  const mc = s.match(/^(.+):(\d+):(\d+)(?:-(\d+))?$/)
  if (mc) {
    const start = parseInt(mc[2], 10)
    return { nonFile: false, filePath: mc[1], startLine: start, endLine: start, malformed: false, bareCandidate: false }
  }
  // Greedy path capture so the LAST `:digits` is the line suffix — keeps the
  // Windows drive colon (C:\...) attached to the path.
  const m = s.match(/^(.+):(\d+)(?:-(\d+))?$/)
  if (m) {
    const start = parseInt(m[2], 10)
    const end = m[3] != null ? parseInt(m[3], 10) : start
    return { nonFile: false, filePath: m[1], startLine: start, endLine: end, malformed: false, bareCandidate: false }
  }
  if (looksLikeFile(s)) {
    // A file-like token with a broken trailing line-spec is malformed, not a path
    // literally named "foo.ts:1-".
    if (BROKEN_LINESPEC.test(s)) {
      return { nonFile: false, filePath: s, startLine: null, endLine: null, malformed: true, bareCandidate: false }
    }
    return { nonFile: false, filePath: s, startLine: null, endLine: null, malformed: false, bareCandidate: false }
  }
  // Bare, whitespace-free token (e.g. Makefile, LICENSE, Dockerfile): a candidate
  // file whose existence decides. Internal whitespace excludes commands like
  // `npm test`, which stay NON_FILE.
  if (!/\s/.test(s)) {
    return { nonFile: false, filePath: s, startLine: null, endLine: null, malformed: false, bareCandidate: true }
  }
  return { nonFile: true, ...none, malformed: false, bareCandidate: false }
}

function isTooGeneric(anchor: string, lines: string[], minChars: number): string | null {
  const trimmed = anchor.trim()
  const nonWs = trimmed.replace(/\s+/g, "")
  if (nonWs.length < minChars) return `anchor under ${minChars} non-space chars`
  if (/^[^A-Za-z0-9]+$/.test(trimmed)) return "anchor is pure punctuation"
  if (GENERIC_STOPWORDS.has(trimmed.toLowerCase())) return "anchor is a single common keyword"
  // Count with the SAME predicate the confirmation/drift paths use, so an anchor
  // whose normalized form appears on >1 line is gated before direct confirmation.
  const nAnchor = normalizeWs(anchor)
  let hits = 0
  for (const ln of lines) {
    if (ln.includes(anchor) || normalizeWs(ln).includes(nAnchor)) {
      hits++
      if (hits > 1) return "anchor occurs on more than one line (non-discriminating)"
    }
  }
  return null
}

function tokenizeBackticks(s: string): Seg[] {
  const segs: Seg[] = []
  let i = 0
  const n = s.length
  let textBuf = ""
  while (i < n) {
    if (s[i] === "`") {
      let run = 0
      while (i + run < n && s[i + run] === "`") run++
      let j = i + run
      let found = -1
      while (j < n) {
        if (s[j] === "`") {
          let k = 0
          while (j + k < n && s[j + k] === "`") k++
          if (k === run) {
            found = j
            break
          }
          j += k
        } else {
          j++
        }
      }
      if (found === -1) {
        textBuf += s.slice(i, i + run)
        i += run
      } else {
        if (textBuf) {
          segs.push({ code: false, text: textBuf })
          textBuf = ""
        }
        let inner = s.slice(i + run, found)
        if (inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim().length) {
          inner = inner.slice(1, -1)
        }
        segs.push({ code: true, text: inner })
        i = found + run
      }
    } else {
      textBuf += s[i]
      i++
    }
  }
  if (textBuf) segs.push({ code: false, text: textBuf })
  return segs
}

function splitGroups(segs: Seg[]): Seg[][] {
  const groups: Seg[][] = []
  let cur: Seg[] = []
  const sepRe = /,\s+|\s+or\s+/g
  for (const seg of segs) {
    if (seg.code) {
      cur.push(seg)
      continue
    }
    // Collapse whitespace runs before the separator scan. The separators match the
    // same boundaries whether a run is 1 char or 50000, and code segments (which
    // carry the verbatim refs/anchors) are never touched — this removes the
    // O(n^2) backtracking the greedy \s+ would otherwise do on a long space run.
    const text = seg.text.replace(/\s+/g, " ")
    sepRe.lastIndex = 0
    let last = 0
    let m: RegExpExecArray | null
    while ((m = sepRe.exec(text)) !== null) {
      const before = text.slice(last, m.index)
      if (before) cur.push({ code: false, text: before })
      if (cur.length) groups.push(cur)
      cur = []
      last = m.index + m[0].length
    }
    const rest = text.slice(last)
    if (rest) cur.push({ code: false, text: rest })
  }
  if (cur.length) groups.push(cur)
  return groups
}

function groupToRef(group: Seg[]): { refRaw: string; anchor: string | null } | null {
  const codes = group.filter((s) => s.code).map((s) => s.text.trim()).filter(Boolean)
  if (codes.length >= 1) {
    return { refRaw: codes[0], anchor: codes.length >= 2 ? codes[1] : null }
  }
  const text = group.map((s) => s.text).join("").trim()
  if (!text) return null
  return { refRaw: text, anchor: null }
}

function parseMarkdownRefs(text: string): ParsedRef[] {
  const out: ParsedRef[] = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  lines.forEach((line, idx) => {
    // Toggle fenced-code state on ``` / ~~~ delimiter lines (CommonMark fences),
    // then skip — Evidence examples inside a fence are documentation, not citations.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const labelMatch = EVIDENCE_LABEL.exec(line)
    if (!labelMatch) return
    const remainder = line.slice(labelMatch.index + labelMatch[0].length)
    const groups = splitGroups(tokenizeBackticks(remainder))
    for (const g of groups) {
      const gr = groupToRef(g)
      if (!gr) continue
      const p = parseRefToken(gr.refRaw)
      out.push({
        origin: `Evidence@L${idx + 1}`,
        raw: gr.refRaw,
        filePath: p.nonFile ? null : p.filePath,
        startLine: p.nonFile ? null : p.startLine,
        endLine: p.nonFile ? null : p.endLine,
        anchor: gr.anchor,
        nonFile: p.nonFile,
        malformed: p.nonFile ? false : p.malformed,
        bareCandidate: p.nonFile ? false : p.bareCandidate,
      })
    }
  })
  return out
}

function collectMachineRefs(root: unknown): RawRef[] {
  const out: RawRef[] = []
  const sourcesById = new Map<string, { ref?: string; anchor?: string; type?: string }>()

  const indexWalk = (node: unknown, depth: number) => {
    if (depth > MAX_JSON_DEPTH) return
    if (Array.isArray(node)) {
      for (const el of node) indexWalk(el, depth + 1)
      return
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (SOURCE_KEYS.has(k) && Array.isArray(v)) {
          for (const el of v) {
            if (el && typeof el === "object" && typeof (el as Record<string, unknown>).id === "string") {
              const e = el as Record<string, unknown>
              sourcesById.set(e.id as string, {
                ref: typeof e.ref === "string" ? e.ref : undefined,
                anchor: typeof e.anchor === "string" ? e.anchor : undefined,
                type: typeof e.type === "string" ? e.type : undefined,
              })
            }
          }
        }
        indexWalk(v, depth + 1)
      }
    }
  }
  indexWalk(root, 0)

  const walk = (node: unknown, origin: string, keyName: string | null, depth: number) => {
    if (depth > MAX_JSON_DEPTH) return
    if (Array.isArray(node)) {
      if (keyName && EVIDENCE_KEYS.has(keyName)) {
        node.forEach((el, i) => {
          const o = `${origin}[${i}]`
          if (typeof el === "string") {
            out.push({ origin: o, refStr: el, anchor: null })
          } else if (el && typeof el === "object" && typeof (el as Record<string, unknown>).ref === "string") {
            const e = el as Record<string, unknown>
            out.push({ origin: o, refStr: e.ref as string, anchor: typeof e.anchor === "string" ? e.anchor : null })
          } else {
            out.push({ origin: o, refStr: null, anchor: null, malformed: true })
          }
        })
        return
      }
      if (keyName && SOURCE_KEYS.has(keyName)) {
        node.forEach((el, i) => {
          if (el && typeof el === "object" && typeof (el as Record<string, unknown>).ref === "string") {
            const e = el as Record<string, unknown>
            const t = typeof e.type === "string" ? (e.type as string) : undefined
            out.push({
              origin: `${origin}[${i}].ref`,
              refStr: e.ref as string,
              anchor: typeof e.anchor === "string" ? (e.anchor as string) : null,
              nonFileHint: t !== undefined && t !== "code",
            })
          }
        })
        return
      }
      if (keyName === "source_ids") {
        node.forEach((el, i) => {
          if (typeof el === "string") {
            const src = sourcesById.get(el)
            const o = `${origin}[${i}]->${el}`
            if (src && typeof src.ref === "string") {
              out.push({
                origin: o,
                refStr: src.ref,
                anchor: src.anchor ?? null,
                nonFileHint: src.type !== undefined && src.type !== "code",
              })
            } else {
              out.push({ origin: o, refStr: null, anchor: null, malformed: true })
            }
          }
        })
        return
      }
      node.forEach((el, i) => walk(el, `${origin}[${i}]`, keyName, depth + 1))
      return
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, origin ? `${origin}.${k}` : k, k, depth + 1)
      }
    }
  }
  walk(root, "", null, 0)
  return out
}

function rawToParsed(r: RawRef): ParsedRef {
  if (r.malformed || r.refStr == null) {
    return {
      origin: r.origin,
      raw: r.refStr ?? "",
      filePath: null,
      startLine: null,
      endLine: null,
      anchor: r.anchor ?? null,
      nonFile: false,
      malformed: true,
      bareCandidate: false,
    }
  }
  const p = parseRefToken(r.refStr)
  const nonFile = p.nonFile || !!r.nonFileHint
  return {
    origin: r.origin,
    raw: r.refStr,
    filePath: nonFile ? null : p.filePath,
    startLine: nonFile ? null : p.startLine,
    endLine: nonFile ? null : p.endLine,
    anchor: r.anchor ?? null,
    nonFile,
    malformed: !nonFile && p.malformed,
    bareCandidate: !nonFile && p.bareCandidate,
  }
}

function sniff(text: string): "markdown" | "machine_json" {
  const t = text.replace(/^﻿/, "").replace(/^\s+/, "")
  return t.startsWith("{") ? "machine_json" : "markdown"
}

type LinesResult = string[] | "UNDECODABLE"

async function readFileCached(abs: string, cache: Map<string, LinesResult>): Promise<LinesResult> {
  const cached = cache.get(abs)
  if (cached !== undefined) return cached
  const buf = await fs.readFile(abs)
  let res: LinesResult
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    res = "UNDECODABLE"
  } else {
    let str = buf.toString("utf8")
    if (str.charCodeAt(0) === 0xfeff) str = str.slice(1)
    res = str.split(/\r?\n/)
  }
  cache.set(abs, res)
  return res
}

type ResolveResult =
  | { abs: string; caseMismatch: boolean }
  | { error: "NOT_FOUND" | "TRAVERSAL" | "IS_DIR" }

async function resolveExisting(
  repoRoot: string,
  relNorm: string,
  caseInsensitive: boolean
): Promise<ResolveResult> {
  const abs = path.resolve(repoRoot, relNorm)
  const rel = path.relative(repoRoot, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: "TRAVERSAL" }

  // Walk each path segment to learn the TRUE on-disk casing. This is correct on
  // both case-sensitive and case-insensitive filesystems — fs.stat must not be
  // trusted for case, because NTFS/APFS silently resolve a wrong-case path to the
  // real file, which would otherwise yield a false CONFIRMED.
  const segs = rel.split(path.sep).filter(Boolean)
  let cur = repoRoot
  let mism = false
  for (const seg of segs) {
    let entries: string[]
    try {
      entries = await fs.readdir(cur)
    } catch {
      return { error: "NOT_FOUND" }
    }
    let next = entries.find((e) => e === seg)
    if (!next) {
      next = entries.find((e) => e.toLowerCase() === seg.toLowerCase())
      if (next) {
        // Wrong on-disk casing for this segment.
        if (!caseInsensitive) return { error: "NOT_FOUND" }
        mism = true
      }
    }
    if (!next) return { error: "NOT_FOUND" }
    cur = path.join(cur, next)
  }
  try {
    const st = await fs.stat(cur)
    if (st.isDirectory()) return { error: "IS_DIR" }
  } catch {
    return { error: "NOT_FOUND" }
  }
  return { abs: cur, caseMismatch: mism }
}

interface EvalOpts {
  driftWindow: number
  minAnchorChars: number
  caseInsensitive: boolean
}

async function evaluateRef(
  ref: ParsedRef,
  repoRoot: string,
  opts: EvalOpts,
  cache: Map<string, LinesResult>
): Promise<{ verdict: Verdict; detail: string; lineDisplay: string }> {
  const lineDisplay =
    ref.startLine == null
      ? ""
      : ref.endLine != null && ref.endLine !== ref.startLine
        ? `${ref.startLine}-${ref.endLine}`
        : `${ref.startLine}`

  if (ref.malformed) return { verdict: "MALFORMED", detail: "malformed evidence reference", lineDisplay }
  if (ref.nonFile || ref.filePath == null) {
    return { verdict: "NON_FILE", detail: "non-file reference (command/ticket/url/spec/discovery)", lineDisplay }
  }

  const relNorm = ref.filePath.replace(/\\/g, "/")
  const resolved = await resolveExisting(repoRoot, relNorm, opts.caseInsensitive)
  if ("error" in resolved) {
    if (resolved.error === "TRAVERSAL") return { verdict: "MALFORMED", detail: "PATH_TRAVERSAL outside repo_root", lineDisplay }
    if (resolved.error === "IS_DIR") return { verdict: "MALFORMED", detail: "PATH_IS_DIRECTORY", lineDisplay }
    // A bare extensionless token that does not resolve is a command/word, not a
    // missing file — keep it NON_FILE so it does not falsely fail the gate.
    if (ref.bareCandidate) {
      return { verdict: "NON_FILE", detail: "non-file reference (unresolved bare token)", lineDisplay }
    }
    return { verdict: "MISSING", detail: "PATH_NOT_FOUND", lineDisplay }
  }

  const linesOrErr = await readFileCached(resolved.abs, cache)
  if (linesOrErr === "UNDECODABLE") return { verdict: "UNDECODABLE", detail: "non-UTF-8 file (UTF-16 BOM)", lineDisplay }
  const lines = linesOrErr
  const caseNote = resolved.caseMismatch ? " (PATH_CASE_MISMATCH)" : ""

  if (ref.startLine == null) {
    return {
      verdict: resolved.caseMismatch ? "CASE_MISMATCH" : "UNANCHORED",
      detail: `file exists, no line cited${caseNote}`,
      lineDisplay,
    }
  }

  const hi = ref.endLine ?? ref.startLine
  if (ref.startLine < 1 || hi < ref.startLine) {
    return { verdict: "MALFORMED", detail: "invalid line or reversed range", lineDisplay }
  }
  if (ref.startLine > lines.length) {
    return { verdict: "MISSING", detail: `LINE_OUT_OF_RANGE (file has ${lines.length} lines)`, lineDisplay }
  }
  if (hi > lines.length) {
    return { verdict: "MALFORMED", detail: `range past EOF (file has ${lines.length} lines)`, lineDisplay }
  }

  if (!ref.anchor || !ref.anchor.trim()) {
    return {
      verdict: resolved.caseMismatch ? "CASE_MISMATCH" : "UNANCHORED",
      detail: `line exists, no anchor${caseNote}`,
      lineDisplay,
    }
  }

  const generic = isTooGeneric(ref.anchor, lines, opts.minAnchorChars)
  if (generic) return { verdict: "ANCHOR_TOO_GENERIC", detail: generic, lineDisplay }

  const anchor = ref.anchor
  const lo = ref.startLine
  const loLine = lines[lo - 1]

  if (loLine.includes(anchor)) {
    return {
      verdict: resolved.caseMismatch ? "CASE_MISMATCH" : "CONFIRMED",
      detail: `anchor present at line ${lo}${caseNote}`,
      lineDisplay,
    }
  }
  const nAnchor = normalizeWs(anchor)
  if (normalizeWs(loLine).includes(nAnchor)) {
    return {
      verdict: resolved.caseMismatch ? "CASE_MISMATCH" : "CONFIRMED_NORMALIZED",
      detail: `anchor present at line ${lo} after whitespace normalization${caseNote}`,
      lineDisplay,
    }
  }
  if (loLine.toLowerCase().includes(anchor.toLowerCase())) {
    return { verdict: "CASE_MISMATCH", detail: `anchor present at line ${lo} only when ignoring case`, lineDisplay }
  }

  const from = Math.max(1, lo - opts.driftWindow)
  const to = Math.min(lines.length, hi + opts.driftWindow)
  const hits: number[] = []
  for (let ln = from; ln <= to; ln++) {
    if (ln === lo) continue
    const content = lines[ln - 1]
    if (content.includes(anchor) || normalizeWs(content).includes(nAnchor)) hits.push(ln)
  }
  if (hits.length === 0) return { verdict: "MISSING", detail: "ANCHOR_NOT_FOUND_IN_WINDOW", lineDisplay }
  if (hits.length > 1) return { verdict: "AMBIGUOUS", detail: `anchor matches ${hits.length} lines in window`, lineDisplay }
  const corrected = hits[0]
  return { verdict: "DRIFTED", detail: `anchor found at line ${corrected} (distance ${corrected - lo})`, lineDisplay }
}

export async function verifyCitations(
  input: VerifyCitationsInput
): Promise<{ data: VerifyCitationsResult; text: string }> {
  const hasText = typeof input.spec_text === "string"
  const hasPath = typeof input.spec_path === "string"
  if (hasText === hasPath) {
    throw new Error("verify_citations requires exactly one of spec_text or spec_path")
  }

  const repoRoot = path.resolve(input.repo_root ?? process.cwd())
  const driftWindow = input.drift_window ?? 25
  const minAnchorChars = input.min_anchor_chars ?? 8
  const caseInsensitive = input.case_insensitive_path ?? true

  let rawText: string
  let source: string
  if (hasPath) {
    const relSpec = input.spec_path!.replace(/\\/g, "/")
    const specAbs = path.resolve(repoRoot, relSpec)
    const specRel = path.relative(repoRoot, specAbs)
    if (specRel.startsWith("..") || path.isAbsolute(specRel)) {
      throw new Error(`verify_citations: spec_path resolves outside repo_root (PATH_TRAVERSAL): ${relSpec}`)
    }
    let buf: Buffer
    try {
      buf = await fs.readFile(specAbs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT") throw new Error(`verify_citations: cannot read spec_path ${relSpec}: not found`)
      if (code === "EISDIR") throw new Error(`verify_citations: cannot read spec_path ${relSpec}: is a directory`)
      throw new Error(`verify_citations: cannot read spec_path ${relSpec}: ${code ?? (e as Error).message}`)
    }
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      throw new Error(`verify_citations: spec file is not UTF-8 (UTF-16 BOM detected): ${relSpec}`)
    }
    rawText = buf.toString("utf8")
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1)
    source = input.spec_path!
  } else {
    rawText = input.spec_text!
    source = "spec_text"
  }

  let fmt = input.source_format ?? "auto"
  if (fmt === "auto") fmt = sniff(rawText)

  let parsed: ParsedRef[]
  if (fmt === "machine_json") {
    let root: unknown
    try {
      root = JSON.parse(rawText)
    } catch (e) {
      throw new Error(`verify_citations: spec is not valid JSON: ${(e as Error).message}`)
    }
    try {
      parsed = collectMachineRefs(root).map(rawToParsed)
    } catch {
      // Degenerate nesting that defeats the depth guard: emit a deterministic
      // MALFORMED verdict instead of letting a RangeError escape.
      parsed = [{
        origin: "machine_json",
        raw: "",
        filePath: null,
        startLine: null,
        endLine: null,
        anchor: null,
        nonFile: false,
        malformed: true,
        bareCandidate: false,
      }]
    }
  } else {
    parsed = parseMarkdownRefs(rawText)
  }

  const seen = new Set<string>()
  const deduped: ParsedRef[] = []
  for (const p of parsed) {
    const key = [
      p.filePath ?? "",
      p.startLine ?? "",
      p.endLine ?? "",
      p.anchor ?? "",
      p.nonFile ? "nf" : "",
      p.malformed ? "m" : "",
      p.raw,
    ].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(p)
  }

  const cache = new Map<string, LinesResult>()
  const verdicts: RefVerdict[] = []
  for (const ref of deduped) {
    const r = await evaluateRef(ref, repoRoot, { driftWindow, minAnchorChars, caseInsensitive }, cache)
    verdicts.push({
      origin: ref.origin,
      raw: ref.raw,
      path: ref.filePath ?? "",
      line: r.lineDisplay,
      anchor: ref.anchor ?? "",
      verdict: r.verdict,
      detail: r.detail,
    })
  }

  const counts: Record<string, number> = {}
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1
  const FAIL = new Set<Verdict>(["MISSING", "MALFORMED", "UNDECODABLE", "AMBIGUOUS"])
  const passed = !verdicts.some((v) => FAIL.has(v.verdict))

  const data: VerifyCitationsResult = {
    source,
    repo_root: repoRoot,
    total_refs: verdicts.length,
    counts,
    passed,
    verdicts,
  }

  const head = toKeyValue({ source, repo_root: repoRoot, total_refs: verdicts.length, passed })
  const countsLine =
    "counts: " +
    (Object.keys(counts).length
      ? Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "none")
  const table = verdicts.length
    ? toTable(
        ["verdict", "path", "line", "anchor", "detail", "origin"],
        verdicts.map((v) =>
          [v.verdict, v.path || "n/a", v.line || "n/a", v.anchor || "n/a", v.detail || "n/a", v.origin || "n/a"].map(
            String
          )
        )
      )
    : ""
  const text = [head, countsLine, table].filter(Boolean).join("\n\n")

  return { data, text }
}
