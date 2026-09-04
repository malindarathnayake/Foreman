import fs from "fs/promises"
import os from "os"
import { fileURLToPath } from "url"
import path from "path"
import { toKeyValue } from "../lib/toon.js"

const SKILL_NAMES = ["design-partner", "spec-generator", "implementor", "lighttask", "spec-man", "doc-man"] as const

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Reports what this process is running versus what is on disk next to it.
 *
 * Field feedback 2026-09 round 3: after an in-place `npm install -g` the old process
 * kept serving old compiled code while this tool (which re-reads package.json) claimed
 * the new version was loaded. Compiled ESM cannot be reloaded, so the honest answer is
 * two versions and a restart recommendation. Protocol Markdown is different: it is read
 * from disk on every activation, so an edit to an already-registered skill is live.
 *
 * `runningVersion` is the version the server captured at startup (server.ts). When it
 * is omitted (tests, direct calls) the disk version stands in for it.
 */
export async function bundleStatus(runningVersion?: string): Promise<string> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const pkgPath = path.resolve(__dirname, "../../package.json")
  const raw = await fs.readFile(pkgPath, "utf-8")
  const pkg = JSON.parse(raw) as { version: string }

  const running = runningVersion ?? pkg.version
  const disk = pkg.version
  const restartRecommended = running !== disk ? "true" : "unknown"

  // Overrides are enumerated per skill: a project file beats a user file, and either
  // silently shadows the bundled protocol of the same name under every host profile.
  const overrides: string[] = []
  for (const name of SKILL_NAMES) {
    const project = path.resolve(".claude", "skills", name, "SKILL.md")
    const user = path.join(os.homedir(), ".claude", "skills", name, "SKILL.md")
    if (await exists(project)) overrides.push(`${name}=project`)
    else if (await exists(user)) overrides.push(`${name}=user`)
  }

  const kv = toKeyValue({
    bundle_version: running,
    running_version: running,
    runtime_disk_version: disk,
    restart_recommended: restartRecommended,
    compatible: true,
    overrides: overrides.length ? overrides.join(",") : "none",
    skills_source: "disk — protocol Markdown is re-read on every activation",
  })

  return (
    kv +
    "\n\nRELOAD\n" +
    "  Compiled code, tool registration, the host profile, and the stack profile load once at process start.\n" +
    "  When running_version differs from runtime_disk_version, restart the host; there is no reload tool.\n" +
    "  Equal versions do not prove nothing changed (a rebuild under the same version is invisible here).\n" +
    "  runtime_disk_version is the package.json next to the running module; a package installed under\n" +
    "  another npm prefix is not visible to this process.\n" +
    "\nOVERRIDE INFO\n" +
    "  To customize any Foreman skill, create a local SKILL.md file:\n" +
    "    .claude/skills/<skill-name>/SKILL.md\n" +
    "  Local skills always take precedence over MCP-delivered skills.\n" +
    "  Override paths checked:\n" +
    "    ~/.claude/skills/          (user-global)\n" +
    "    .claude/skills/            (project-local)"
  )
}
