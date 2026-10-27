/**
 * Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/) — the format check and the
 * two mechanical edits Foreman makes to a project's CHANGELOG.md (0.7.0, owner request).
 *
 * The check is deterministic: no model judges it. It is the "release-note doctor"'s first
 * half; the second half is a reviewer seat that rewrites internal language for users, run by
 * the protocol, not here. Foreman's own CHANGELOG.md passes the same check (releaseInvariants).
 *
 * Parsing is fence-aware: a `## ` line inside a ``` or ~~~ code block is content, not a section
 * boundary. Versions follow SemVer 2.0.0 (validation and precedence, build metadata ignored for
 * ordering). Link reference definitions (`[x]: url`) are not entries.
 */

export const KAC_CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const

export const KAC_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
`

// SemVer 2.0.0 (semver.org regex, without the leading anchor groups' names).
const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?`
const SEMVER_RE = new RegExp(`^${SEMVER}$`)
const RELEASE = new RegExp(String.raw`^## \[(${SEMVER})\] - (\d{4}-\d{2}-\d{2})(?: \[YANKED\])?\s*$`)
const UNRELEASED = /^## \[Unreleased\]\s*$/
const LINK_DEF = /^\[[^\]]+\]:\s+\S/

export interface ChangelogIssue { line: number; issue: string }

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function isSemver(v: string): boolean { return SEMVER_RE.test(v) }

/** SemVer 2.0.0 precedence: negative when a < b. Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const [ca, pa] = splitVersion(a)
  const [cb, pb] = splitVersion(b)
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i]
  if (pa.length === 0 && pb.length === 0) return 0
  if (pa.length === 0) return 1          // a release outranks its prereleases
  if (pb.length === 0) return -1
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1
    if (i >= pb.length) return 1
    const x = pa[i], y = pb[i]
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d !== 0) return d; continue }
    if (nx !== ny) return nx ? -1 : 1     // numeric identifiers rank below alphanumeric
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
function splitVersion(v: string): [number[], string[]] {
  const noBuild = v.split("+")[0]
  const dash = noBuild.indexOf("-")
  const core = (dash < 0 ? noBuild : noBuild.slice(0, dash)).split(".").map(Number)
  const pre = dash < 0 ? [] : noBuild.slice(dash + 1).split(".")
  return [core, pre]
}

/** Lines with a flag for whether each sits inside a fenced code block (fence lines included). */
function scan(text: string): Array<{ line: string; fenced: boolean }> {
  const out: Array<{ line: string; fenced: boolean }> = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(```+|~~~+)/.exec(line)
    if (m) {
      if (fence === null) { fence = m[1][0]; out.push({ line, fenced: true }); continue }
      if (m[1][0] === fence) { fence = null; out.push({ line, fenced: true }); continue }
    }
    out.push({ line, fenced: fence !== null })
  }
  return out
}

/** Every way the text departs from Keep a Changelog 1.1.0, with its line. Empty = conforms. */
export function checkChangelog(text: string): ChangelogIssue[] {
  const lines = scan(text)
  const issues: ChangelogIssue[] = []
  if (lines[0]?.line.trim() !== "# Changelog") issues.push({ line: 1, issue: "first line must be '# Changelog'" })
  let sawUnreleased = false
  let prevVersion: string | undefined
  let prevDate: string | undefined
  let section: string | undefined
  let category: string | undefined
  let categoryItems = 0
  let categoryLine = 0
  const seenCats = new Set<string>()
  const closeCategory = () => {
    if (category !== undefined && categoryItems === 0) issues.push({ line: categoryLine, issue: `'### ${category}' under ${section} has no entries` })
    category = undefined
    categoryItems = 0
  }
  for (let i = 0; i < lines.length; i++) {
    const { line: l, fenced } = lines[i]
    const n = i + 1
    if (fenced) continue
    if (l.startsWith("## ")) {
      closeCategory()
      seenCats.clear()
      if (UNRELEASED.test(l)) {
        if (sawUnreleased) issues.push({ line: n, issue: "more than one [Unreleased] section" })
        if (prevVersion !== undefined) issues.push({ line: n, issue: "[Unreleased] must come before every release" })
        sawUnreleased = true
        section = "[Unreleased]"
        continue
      }
      const m = RELEASE.exec(l)
      if (!m) {
        // A closing archive section ("## Earlier releases") is allowed once releases exist.
        if (prevVersion !== undefined && /^## [A-Z][a-z]/.test(l) && !l.includes("[")) { section = l.slice(3); continue }
        issues.push({ line: n, issue: `release heading must be '## [x.y.z] - YYYY-MM-DD' with a SemVer version (got '${l.slice(0, 60)}')` })
        continue
      }
      const [, version, date] = m
      if (!isIsoDate(date)) issues.push({ line: n, issue: `date '${date}' is not a real calendar date` })
      if (prevVersion !== undefined && compareSemver(version, prevVersion) >= 0) issues.push({ line: n, issue: `release ${version} is not older than ${prevVersion} above it (newest first)` })
      if (prevDate !== undefined && date > prevDate) issues.push({ line: n, issue: `release ${version} is dated after the release above it` })
      prevVersion = version
      prevDate = date
      section = `[${version}]`
      continue
    }
    if (l.startsWith("### ")) {
      closeCategory()
      const name = l.slice(4).trim()
      if (!(KAC_CATEGORIES as readonly string[]).includes(name)) issues.push({ line: n, issue: `'### ${name}' is not a Keep a Changelog category (${KAC_CATEGORIES.join(", ")})` })
      else if (seenCats.has(name)) issues.push({ line: n, issue: `'### ${name}' appears twice under ${section}` })
      if (section === undefined) issues.push({ line: n, issue: `'### ${name}' is outside any release section` })
      seenCats.add(name)
      category = name
      categoryLine = n
      continue
    }
    if (category !== undefined && /^\s*[-*] /.test(l)) categoryItems++
  }
  closeCategory()
  if (!sawUnreleased) issues.push({ line: 1, issue: "missing '## [Unreleased]' section" })
  return issues
}

/** [start, end) line range of a section whose heading matches, fence-aware; null when absent. */
function sectionRange(text: string, isHeading: (l: string) => boolean): [number, number] | null {
  const lines = scan(text)
  const start = lines.findIndex((x) => !x.fenced && isHeading(x.line))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].fenced && (lines[i].line.startsWith("## ") || LINK_DEF.test(lines[i].line) && isFooterFrom(lines, i))) { end = i; break }
  }
  return [start, end]
}
/** A link-definition block that runs to the end of the file is the footer, not section content. */
function isFooterFrom(lines: Array<{ line: string; fenced: boolean }>, i: number): boolean {
  for (let j = i; j < lines.length; j++) if (lines[j].line.trim() !== "" && !LINK_DEF.test(lines[j].line)) return false
  return true
}

/** The [Unreleased] section's entries (link definitions excluded), or "" when absent. */
export function unreleasedBody(text: string): string {
  const r = sectionRange(text, (l) => UNRELEASED.test(l))
  if (!r) return ""
  return text.split(/\r?\n/).slice(r[0] + 1, r[1]).filter((l) => !LINK_DEF.test(l)).join("\n").trim()
}

/** The body of one released version plus the link definitions it uses, or null when absent. */
export function releaseBody(text: string, version: string): string | null {
  const r = sectionRange(text, (l) => RELEASE.exec(l)?.[1] === version)
  if (!r) return null
  const lines = text.split(/\r?\n/)
  const body = lines.slice(r[0] + 1, r[1]).join("\n").trim()
  // Keep the definitions this section's reference-style links point at, so notes stand alone.
  const defs = new Map<string, string>()
  for (const l of lines) { const m = /^\[([^\]]+)\]:\s+\S/.exec(l); if (m) defs.set(m[1].toLowerCase(), l) }
  const used = new Set<string>()
  for (const m of body.matchAll(/\]\[([^\]]+)\]|\[([^\]]+)\](?![(:\[])/g)) {
    const key = (m[1] ?? m[2]).toLowerCase()
    if (defs.has(key)) used.add(key)
  }
  const tail = [...used].map((k) => defs.get(k)!).join("\n")
  return tail ? `${body}\n\n${tail}` : body
}

/** The newest released version, or undefined. */
export function latestRelease(text: string): string | undefined {
  for (const { line, fenced } of scan(text)) {
    if (fenced) continue
    const m = RELEASE.exec(line)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Move [Unreleased] under a new release heading and leave an empty [Unreleased] above it.
 * Refuses an empty [Unreleased], a version not newer than the latest release, and a bad date.
 * When the footer carries a `[Unreleased]: <base>/compare/<from>...HEAD` link, it is advanced
 * to the new version and a `[version]` comparison link is added.
 */
export function cutRelease(text: string, version: string, date: string): { text: string } | { refused: string } {
  if (!isSemver(version)) return { refused: `version '${version}' is not SemVer 2.0.0` }
  if (!isIsoDate(date)) return { refused: `date '${date}' is not a real YYYY-MM-DD date` }
  const body = unreleasedBody(text)
  if (!body) return { refused: "[Unreleased] is empty; there is nothing to release" }
  const latest = latestRelease(text)
  if (latest !== undefined && compareSemver(version, latest) <= 0) return { refused: `version ${version} is not newer than the latest release ${latest}` }
  const r = sectionRange(text, (l) => UNRELEASED.test(l))!
  const lines = text.split(/\r?\n/)
  let out = [...lines.slice(0, r[0] + 1), "", `## [${version}] - ${date}`, "", body, "", ...lines.slice(r[1])]
  const linkAt = out.findIndex((l) => /^\[Unreleased\]:\s*(\S+)\/compare\/(\S+)\.\.\.HEAD\s*$/.test(l))
  if (linkAt >= 0) {
    const [, baseUrl, from] = /^\[Unreleased\]:\s*(\S+)\/compare\/(\S+)\.\.\.HEAD\s*$/.exec(out[linkAt])!
    const prefix = from.startsWith("v") ? "v" : ""
    out = [...out.slice(0, linkAt), `[Unreleased]: ${baseUrl}/compare/${prefix}${version}...HEAD`, `[${version}]: ${baseUrl}/compare/${from}...${prefix}${version}`, ...out.slice(linkAt + 1)]
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n") }
}
