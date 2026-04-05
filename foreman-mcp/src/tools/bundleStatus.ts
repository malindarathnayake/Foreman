import fs from "fs/promises"
import { fileURLToPath } from "url"
import path from "path"
import { toKeyValue } from "../lib/toon.js"

export async function bundleStatus(): Promise<string> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const pkgPath = path.resolve(__dirname, "../../package.json")
  const raw = await fs.readFile(pkgPath, "utf-8")
  const pkg = JSON.parse(raw) as { version: string }

  const kv = toKeyValue({
    bundle_version: pkg.version,
    compatible: true,
    update_available: false,
  })

  return (
    kv +
    "\n\nOVERRIDE INFO\n" +
    "  To customize any Foreman skill, create a local SKILL.md file:\n" +
    "    .claude/skills/<skill-name>/SKILL.md\n" +
    "  Local skills always take precedence over MCP-delivered skills.\n" +
    "  Override paths checked:\n" +
    "    ~/.claude/skills/          (user-global)\n" +
    "    .claude/skills/            (project-local)"
  )
}
