/**
 * Mermaid 11's flowchart lexer treats `--` as an edge token. An unquoted label
 * that contains a flag (`--force`) or any other `--` is a lexical error:
 *   D -- no / --force --> O
 * is parsed as two edges. Quoted labels are text:
 *   D -- "no / --force" --> O
 *
 * Applied at every Foreman mermaid ingest (preview_diagram write + the preview
 * server's /api/source) so one diagram cannot ship a lexer bomb. Idempotent:
 * already-quoted labels and unlabeled arrows (`-->`, `---`, `--o`, `--x`) stay
 * put. Node text inside `[]` `()` `{}` and quoted strings is not an edge.
 */

interface Depth {
  quote: '"' | "'" | null
  square: number
  paren: number
  brace: number
}

function freshDepth(): Depth {
  return { quote: null, square: 0, paren: 0, brace: 0 }
}

function inText(d: Depth): boolean {
  return d.quote !== null || d.square > 0 || d.paren > 0 || d.brace > 0
}

function step(d: Depth, ch: string, prev: string): void {
  if (d.quote) {
    if (ch === d.quote && prev !== "\\") d.quote = null
    return
  }
  if (ch === '"' || ch === "'") {
    d.quote = ch
    return
  }
  if (ch === "[") d.square++
  else if (ch === "]" && d.square > 0) d.square--
  else if (ch === "(") d.paren++
  else if (ch === ")" && d.paren > 0) d.paren--
  else if (ch === "{") d.brace++
  else if (ch === "}" && d.brace > 0) d.brace--
}

export function quoteMermaidLabel(raw: string): string {
  const t = raw.trim()
  if (t.length === 0) return t
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t
  }
  return `"${t.replace(/"/g, "#quot;")}"`
}

function findAtDepth(line: string, from: number, token: string): number {
  const d = freshDepth()
  for (let i = from; i < line.length; i++) {
    if (!inText(d) && line.startsWith(token, i)) return i
    step(d, line[i]!, i > 0 ? line[i - 1]! : "")
  }
  return -1
}

function nearestCloser(
  line: string,
  from: number,
  closers: readonly string[]
): { index: number; token: string } | null {
  let best: { index: number; token: string } | null = null
  for (const token of closers) {
    const index = findAtDepth(line, from, token)
    if (index === -1) continue
    if (best === null || index < best.index) best = { index, token }
  }
  return best
}

function quoteEdges(
  line: string,
  open: string,
  closers: readonly string[],
  skipAfter: string
): string {
  const d = freshDepth()
  let out = ""
  let i = 0
  while (i < line.length) {
    if (!inText(d) && line.startsWith(open, i)) {
      const after = line[i + open.length]
      if (after === undefined || !skipAfter.includes(after)) {
        const closer = nearestCloser(line, i + open.length, closers)
        if (closer) {
          const raw = line.slice(i + open.length, closer.index)
          if (raw.trim().length > 0) {
            out += open + " " + quoteMermaidLabel(raw) + " " + closer.token
            const end = closer.index + closer.token.length
            for (let k = i; k < end; k++) {
              step(d, line[k]!, k > 0 ? line[k - 1]! : "")
            }
            i = end
            continue
          }
        }
      }
    }
    out += line[i]
    step(d, line[i]!, i > 0 ? line[i - 1]! : "")
    i++
  }
  return out
}

function commentSplit(line: string): { code: string; comment: string } {
  const d = freshDepth()
  for (let i = 0; i < line.length; i++) {
    if (!inText(d) && line.startsWith("%%", i)) {
      return { code: line.slice(0, i), comment: line.slice(i) }
    }
    step(d, line[i]!, i > 0 ? line[i - 1]! : "")
  }
  return { code: line, comment: "" }
}

function quoteLine(line: string): string {
  const { code, comment } = commentSplit(line)
  let next = quoteEdges(code, "--", ["-->", "---"], "->ox")
  next = quoteEdges(next, "-.", [".->"], "->")
  next = quoteEdges(next, "==", ["==>"], ">")
  return next + comment
}

/** Quote unquoted flowchart edge labels so `--` inside them is not a new edge. */
export function quoteMermaidEdgeLabels(source: string): string {
  const nl = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n"
  const endsWithNl = /[\r\n]$/.test(source)
  const lines = source.split(/\r\n|\n|\r/)
  if (endsWithNl && lines[lines.length - 1] === "") lines.pop()
  const quoted = lines.map(quoteLine).join(nl)
  return endsWithNl ? quoted + nl : quoted
}
