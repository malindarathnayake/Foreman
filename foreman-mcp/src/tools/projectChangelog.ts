/**
 * project_changelog (0.7.0, owner request): keep a repository's root CHANGELOG.md in Keep a
 * Changelog 1.1.0 format. Four operations:
 *
 *   check   — the deterministic half of the "release-note doctor": every departure from the
 *             format, with its line (lib/changelogFormat.ts). No model is involved.
 *   init    — create CHANGELOG.md with the standard header and an empty [Unreleased]; refuses
 *             to overwrite an existing file.
 *   release — move [Unreleased] under `## [version] - date`; refuses an empty [Unreleased] or a
 *             version not newer than the latest release.
 *   notes   — return one version's section, for a release body. Foreman never publishes it:
 *             posting anywhere is the owner's call.
 *
 * Writing the entries is a writer seat's job and rewording them for users a reviewer seat's,
 * both run by the protocol at a phase gate — this tool only checks and moves text.
 *
 * Writes go through the ledger window check: while a worker holds the repository window, a
 * CHANGELOG.md write would be charged to that attempt by the guard, so it is refused.
 */
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import { checkChangelog, cutRelease, KAC_HEADER, releaseBody, unreleasedBody } from "../lib/changelogFormat.js"
import { whileWindowClosed } from "../lib/ledger.js"
import { toKeyValue } from "../lib/toon.js"

export const ProjectChangelogInputSchema = z.strictObject({
  operation: z.enum(["check", "init", "release", "notes"]),
  /** release / notes: the version, semver without a leading v. */
  version: z.string().trim().min(5).max(40).optional(),
  /** release: YYYY-MM-DD; today (UTC) when omitted. */
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})
export type ProjectChangelogInput = z.infer<typeof ProjectChangelogInputSchema>

const FILE = "CHANGELOG.md"

export async function projectChangelog(raw: unknown, root: string, ledgerPath?: string): Promise<string> {
  const input = ProjectChangelogInputSchema.parse(raw)
  const file = path.join(path.resolve(root), FILE)
  // 0.7.0 (Codex review): only ENOENT is "missing"; any other read error is reported, never
  // treated as absence (an EACCES must not lead init to replace an existing history).
  let text: string | null = null
  try { text = await fs.readFile(file, "utf-8") } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return toKeyValue({ operation: input.operation, status: "error", file: FILE, reason: `cannot read ${FILE}: ${(err as NodeJS.ErrnoException).code ?? "error"}` })
    }
  }

  if (input.operation === "check") {
    if (text === null) return toKeyValue({ operation: "check", status: "missing", file: FILE, hint: "project_changelog { operation: 'init' } creates it" })
    const issues = checkChangelog(text)
    const head = toKeyValue({ operation: "check", status: issues.length ? "issues" : "ok", file: FILE, issues: issues.length, unreleased_entries: (unreleasedBody(text).match(/^\s*[-*] /gm) ?? []).length })
    return issues.length ? `${head}\nISSUES\n${issues.slice(0, 50).map((i) => `  - line ${i.line}: ${i.issue}`).join("\n")}` : head
  }

  if (input.operation === "notes") {
    if (text === null) return toKeyValue({ operation: "notes", status: "missing", file: FILE })
    if (!input.version) return toKeyValue({ operation: "notes", status: "refused", reason: "version is required" })
    const body = releaseBody(text, input.version)
    if (body === null) return toKeyValue({ operation: "notes", status: "refused", reason: `no release ${input.version} in ${FILE}` })
    return `${toKeyValue({ operation: "notes", status: "ok", version: input.version, note: "draft for a release body; publishing it is the owner's call" })}\n\n${body}`
  }

  // init / release write the file: not while a worker holds the repository window. The check and
  // the write run under the ledger lock (whileWindowClosed), so a window cannot open in between.
  const write = async (fn: () => Promise<string>): Promise<string> => {
    if (!ledgerPath) return fn()
    const r = await whileWindowClosed(ledgerPath, fn)
    return "value" in r ? r.value : toKeyValue({ operation: input.operation, status: "refused", reason: r.refused, hint: "record its verdict or close the attempt first" })
  }

  if (input.operation === "init") {
    if (text !== null) return toKeyValue({ operation: "init", status: "exists", file: FILE, hint: "project_changelog { operation: 'check' } reports any format issues" })
    return write(async () => {
      // Exclusive create: never replaces a file that appeared since the read.
      try { await fs.writeFile(file, KAC_HEADER, { encoding: "utf-8", flag: "wx" }) } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return toKeyValue({ operation: "init", status: "exists", file: FILE })
        throw err
      }
      return toKeyValue({ operation: "init", status: "created", file: FILE })
    })
  }

  // release
  if (text === null) return toKeyValue({ operation: "release", status: "missing", file: FILE })
  if (!input.version) return toKeyValue({ operation: "release", status: "refused", reason: "version is required" })
  const date = input.date ?? new Date().toISOString().slice(0, 10)
  const cut = cutRelease(text, input.version, date)
  if ("refused" in cut) return toKeyValue({ operation: "release", status: "refused", reason: cut.refused })
  const issues = checkChangelog(cut.text)
  if (issues.length) return toKeyValue({ operation: "release", status: "refused", reason: `the result would not conform: line ${issues[0].line}: ${issues[0].issue}`, hint: "fix the file (check) and release again" })
  const version = input.version
  return write(async () => {
    // Re-read under the lock: the file must be the one the release was cut from.
    const now = await fs.readFile(file, "utf-8")
    if (now !== text) return toKeyValue({ operation: "release", status: "refused", reason: `${FILE} changed while the release was prepared; run it again` })
    await atomicWriteFile(file, cut.text)
    return toKeyValue({ operation: "release", status: "released", version, date, hint: "project_changelog { operation: 'notes', version } returns the section for a release body" })
  })
}
