import fs from "fs/promises"
import os from "os"
import { fileURLToPath } from "url"
import path from "path"
import { toKeyValue } from "../lib/toon.js"
import {
  captureRuntimeSnapshot,
  compareRuntimeSnapshots,
  type RestartVerdict,
  type RuntimeSnapshot,
} from "../lib/runtimeSnapshot.js"

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
 * Round 4: "restart_recommended: unknown" on every same-version call was the only thing
 * this tool ever said in practice. The server now captures a snapshot of dist/,
 * package.json, and the startup-read files when it starts (server.ts) and hands it in
 * as `startup`; the answer is a comparison against disk now: true with what changed,
 * false, or n/a with why the comparison could not run. Without a snapshot (tests,
 * direct calls) only the version is compared.
 */
export async function bundleStatus(
  runningVersion?: string,
  startup?: RuntimeSnapshot | { error: string }
): Promise<string> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const packageRoot = path.resolve(__dirname, "../..")
  const pkgPath = path.join(packageRoot, "package.json")
  const raw = await fs.readFile(pkgPath, "utf-8")
  const pkg = JSON.parse(raw) as { version: string }

  const running = runningVersion ?? pkg.version
  const disk = pkg.version

  let restart: RestartVerdict
  if (startup === undefined) {
    restart = running !== disk
      ? { recommended: "true", reason: `runtime_disk_version ${disk} differs from running_version ${running}` }
      : { recommended: "n/a", reason: "no process-start snapshot for this call; only the version was compared" }
  } else if ("error" in startup) {
    restart = { recommended: "n/a", reason: `process-start snapshot failed: ${startup.error}` }
  } else {
    try {
      const now = await captureRuntimeSnapshot({ packageRoot, extraFiles: Object.keys(startup.extras) })
      restart = compareRuntimeSnapshots(startup, now)
    } catch (err) {
      restart = { recommended: "n/a", reason: `re-scan of the runtime files failed: ${(err as Error).message}` }
    }
  }

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
    restart_recommended: restart.recommended,
    restart_reason: restart.reason,
    compatible: true,
    overrides: overrides.length ? overrides.join(",") : "none",
    skills_source: "disk — protocol Markdown is re-read on every activation",
  })

  return (
    kv +
    "\n\nRELOAD\n" +
    "  Compiled code, tool registration, the host profile, and the stack profile load once at process start.\n" +
    "  restart_recommended compares dist/, package.json, and the files read once at start (the stack profile\n" +
    "  override) against a snapshot taken when this process started: true names what changed, false means\n" +
    "  nothing did, n/a names why the comparison could not run. When true, restart the host; there is no reload tool.\n" +
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
