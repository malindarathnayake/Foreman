#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

import { bundleStatus } from "./tools/bundleStatus.js"
import { changelog } from "./tools/changelog.js"
import { handleReadLedger } from "./tools/readLedger.js"
import { handleReadProgress } from "./tools/readProgress.js"
import { capabilityCheck } from "./tools/capabilityCheck.js"
import { handleWriteLedger } from "./tools/writeLedger.js"
import { handleWriteProgress } from "./tools/writeProgress.js"
import { normalizeReview } from "./tools/normalizeReview.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ServerConfig {
  ledgerPath?: string
  progressPath?: string
  docsDir?: string
}

export async function createServer(config?: ServerConfig): Promise<McpServer> {
  const ledgerPath = config?.ledgerPath ?? "Docs/.foreman-ledger.json"
  const progressPath = config?.progressPath ?? "Docs/.foreman-progress.json"
  const docsDir = config?.docsDir ?? "Docs"

  const server = new McpServer(
    { name: "foreman", version: "0.0.3-3" },
    { capabilities: { resources: {}, tools: {} } }
  )

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "bundle_status",
    { description: "Returns the Foreman bundle version and override info." },
    async (_extra) => {
      const text = await bundleStatus()
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "changelog",
    {
      description: "Returns the Foreman changelog, optionally since a version.",
      inputSchema: {
        since_version: z.string().optional(),
      },
    },
    async (args, _extra) => {
      const text = changelog(args.since_version)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "read_ledger",
    {
      description: "Reads the Foreman ledger file.",
      inputSchema: {
        unit_id: z.string().optional(),
        phase: z.string().optional(),
        query: z.enum(["verdicts", "rejections", "phase_gates", "full"]).optional(),
      },
    },
    async (args, _extra) => {
      const text = await handleReadLedger(ledgerPath, args)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "read_progress",
    {
      description: "Reads the Foreman progress file.",
      inputSchema: {
        last_n_completed: z.number().optional(),
      },
    },
    async (args, _extra) => {
      const text = await handleReadProgress(progressPath, args.last_n_completed)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "capability_check",
    {
      description: "Checks whether codex or gemini CLI is available.",
      inputSchema: {
        cli: z.enum(["codex", "gemini"]),
      },
    },
    async (args, _extra) => {
      const text = await capabilityCheck(args.cli)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "write_ledger",
    {
      description: [
        "Writes an operation to the Foreman ledger file.",
        "",
        "Operations:",
        "  set_unit_status — Set a unit's status. data: { s: 'pending'|'ip'|'done'|'fail' }. Requires: phase, unit_id.",
        "  set_verdict     — Record pass/fail verdict. data: { v: 'pass'|'fail'|'pending' }. Requires: phase, unit_id.",
        "  add_rejection   — Log a rejection. data: { r: string, msg: string, ts: string }. Requires: phase, unit_id.",
        "  update_phase_gate — Set phase gate result. data: { g: 'pass'|'fail'|'pending' }. Requires: phase.",
      ].join("\n"),
      inputSchema: {
        operation: z.enum(["set_unit_status", "set_verdict", "add_rejection", "update_phase_gate"]),
        unit_id: z.string().optional(),
        phase: z.string().optional(),
        data: z.record(z.unknown()),
      },
    },
    async (args, _extra) => {
      const text = await handleWriteLedger(ledgerPath, args)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "write_progress",
    {
      description: [
        "Writes an operation to the Foreman progress file.",
        "",
        "Operations:",
        "  start_phase   — Initialize a new phase. data: { phase: string, name: string }.",
        "  update_status — Set unit status. data: { unit_id: string, phase: string, status: string, notes: string }.",
        "  complete_unit — Mark unit done. data: { unit_id: string, phase: string, completed_at: string, notes: string }.",
        "  log_error     — Log an error. data: { date: string, unit: string, what_failed: string, next_approach: string }.",
      ].join("\n"),
      inputSchema: {
        operation: z.enum(["update_status", "complete_unit", "log_error", "start_phase"]),
        data: z.record(z.unknown()),
      },
    },
    async (args, _extra) => {
      const text = await handleWriteProgress(progressPath, args, docsDir)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "normalize_review",
    {
      description: "Normalizes raw review text into structured findings.",
      inputSchema: {
        reviewer: z.string(),
        raw_text: z.string(),
      },
    },
    async (args, _extra) => {
      const { text } = normalizeReview(args.reviewer, args.raw_text)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  // ── Skill Resources ────────────────────────────────────────────────────────

  async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true } catch { return false }
  }

  // Resolve skills directory — works from both src/ (dev) and dist/ (production)
  let skillsDir = path.resolve(__dirname, "skills")
  // If running from dist/, skills are in the sibling src/skills/ directory
  if (!await fileExists(skillsDir)) {
    skillsDir = path.resolve(__dirname, "..", "src", "skills")
  }
  let skillFiles: string[] = []
  try {
    const entries = await fs.readdir(skillsDir)
    skillFiles = entries.filter((f) => f.endsWith(".md"))
  } catch {
    console.error(`[foreman] Warning: skills directory not found at ${skillsDir}`)
  }

  for (const file of skillFiles) {
    const name = file.replace(/\.md$/, "")
    const uri = `skill://foreman/${name}`
    const filePath = path.join(skillsDir, file)

    server.registerResource(
      name,
      uri,
      {
        description: `Foreman skill: ${name}`,
        mimeType: "text/markdown",
      },
      async (resourceUri, _extra) => {
        const text = await fs.readFile(filePath, "utf-8")
        return {
          contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text }],
        }
      }
    )
  }

  return server
}

// ── Diagnostics ───────────────────────────────────────────────────────────

async function runDiag(): Promise<void> {
  const log = (label: string, value: string) =>
    console.error(`  ${label.padEnd(20)} ${value}`)

  console.error("\n╔══════════════════════════════════════════╗")
  console.error("║        foreman-mcp diagnostics           ║")
  console.error("╚══════════════════════════════════════════╝\n")

  // Runtime
  console.error("── Runtime ──")
  log("node", process.version)
  log("platform", `${process.platform} ${process.arch}`)
  log("pid", String(process.pid))
  log("cwd", process.cwd())
  log("argv", process.argv.join(" "))
  log("entry", fileURLToPath(import.meta.url))

  // Package
  console.error("\n── Package ──")
  const pkgPath = path.resolve(__dirname, "..", "package.json")
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
    log("name", pkg.name)
    log("version", pkg.version)
  } catch (e: any) {
    log("package.json", `NOT FOUND at ${pkgPath} (${e.message})`)
  }

  // MCP SDK
  console.error("\n── MCP SDK ──")
  try {
    const sdkPkgPath = path.resolve(
      __dirname,
      "..",
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "package.json"
    )
    const sdkPkg = JSON.parse(await fs.readFile(sdkPkgPath, "utf-8"))
    log("sdk version", sdkPkg.version)
  } catch {
    log("sdk version", "UNKNOWN (could not read sdk package.json)")
  }

  // Skills directory
  console.error("\n── Skills ──")
  let resolvedSkillsDir = path.resolve(__dirname, "skills")
  let skillsDirExists = false
  try {
    await fs.access(resolvedSkillsDir)
    skillsDirExists = true
  } catch {
    const fallback = path.resolve(__dirname, "..", "src", "skills")
    try {
      await fs.access(fallback)
      resolvedSkillsDir = fallback
      skillsDirExists = true
    } catch { /* */ }
  }
  log("skills dir", resolvedSkillsDir)
  log("exists", String(skillsDirExists))
  if (skillsDirExists) {
    const entries = await fs.readdir(resolvedSkillsDir)
    const mdFiles = entries.filter((f) => f.endsWith(".md"))
    log("skill files", mdFiles.length > 0 ? mdFiles.join(", ") : "(none)")
  }

  // Server creation test
  console.error("\n── Server ──")
  try {
    const server = await createServer()
    log("createServer()", "OK")

    // Test transport creation (don't actually connect — that blocks on stdin)
    const transport = new StdioServerTransport()
    log("StdioTransport", "OK")

    // Clean up
    void transport
    void server
  } catch (e: any) {
    log("createServer()", `FAILED: ${e.message}`)
    console.error(e.stack)
  }

  // Stdio check
  console.error("\n── Stdio ──")
  log("stdin isTTY", String(process.stdin.isTTY ?? false))
  log("stdout isTTY", String(process.stdout.isTTY ?? false))
  log("stderr isTTY", String(process.stderr.isTTY ?? false))

  console.error("\n── Done ──\n")
}

// ── Entry point ────────────────────────────────────────────────────────────

async function checkIsMain(): Promise<boolean> {
  if (process.argv[1] === undefined) return false
  let resolved: string
  try {
    resolved = path.resolve(await fs.realpath(process.argv[1]))
  } catch {
    resolved = path.resolve(process.argv[1])
  }
  return resolved === path.resolve(fileURLToPath(import.meta.url))
}

const isMain = await checkIsMain()

if (isMain) {
  const args = process.argv.slice(2)

  function printBanner(version: string): void {
    console.log(`
  \x1b[38;2;88;166;255m┌──────────┐\x1b[0m \x1b[32m✓\x1b[0m
  \x1b[38;2;88;166;255m│\x1b[0m
  \x1b[38;2;88;166;255m├──────┐\x1b[0m \x1b[32m✓\x1b[0m
  \x1b[38;2;88;166;255m│\x1b[0m
  \x1b[38;2;88;166;255m○\x1b[0m  \x1b[1mForeman\x1b[0m v${version}
     \x1b[2mWorkflow Orchestrator for AI Coding Agents\x1b[0m
     \x1b[2mCopyright (c) 2026 Malinda Rathnayake — AGPL-3.0\x1b[0m
`)
  }

  async function printVersion(): Promise<void> {
    const pkgPath = path.resolve(__dirname, "..", "package.json")
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
      printBanner(pkg.version)
    } catch {
      printBanner("unknown")
    }
  }

  if (args.includes("--version") || args.includes("-v")) {
    await printVersion()
    process.exit(0)
  } else if (args.includes("--diag")) {
    runDiag().then(() => process.exit(0)).catch((e) => {
      console.error("Diag failed:", e)
      process.exit(1)
    })
  } else if (process.stdin.isTTY) {
    // Interactive terminal with no flags — print version and usage hint
    await printVersion()
    console.log("Usage:")
    console.log("  foreman-mcp           Start MCP server (stdin/stdout, used by Claude Code)")
    console.log("  foreman-mcp --version  Print version and exit")
    console.log("  foreman-mcp --diag     Run diagnostics and exit")
    process.exit(0)
  } else {
    // Non-TTY stdin — MCP client is connecting, start the server
    createServer().then(async (server) => {
      const transport = new StdioServerTransport()
      await server.connect(transport)
    })
  }
}
