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
import { runTests } from "./tools/runTests.js"
import { activateImplementor } from "./tools/activateImplementor.js"
import { activateDesignPartner } from "./tools/activateDesignPartner.js"
import { activateSpecGenerator } from "./tools/activateSpecGenerator.js"
import { NormalizeReviewInputSchema } from "./types.js"
import { readJournal, initSession, logEvent, endSession } from "./lib/journal.js"
import { invokeAdvisor, formatAdvisorResult } from "./tools/invokeAdvisor.js"
import { sessionOrient } from "./tools/sessionOrient.js"
import { renderIncludes, loadSkill } from "./lib/skillLoader.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ServerConfig {
  ledgerPath?: string
  progressPath?: string
  journalPath?: string
  docsDir?: string
}

export async function createServer(config?: ServerConfig): Promise<McpServer> {
  const ledgerPath = config?.ledgerPath ?? "Docs/.foreman-ledger.json"
  const progressPath = config?.progressPath ?? "Docs/.foreman-progress.json"
  const docsDir = config?.docsDir ?? "Docs"
  const journalPath = config?.journalPath ?? "Docs/.foreman-journal.json"

  const server = new McpServer(
    { name: "foreman", version: "0.0.7.5" },
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
        since_version: z.string().max(20).optional(),
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
        unit_id: z.string().max(10000).optional(),
        phase: z.string().max(10000).optional(),
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
        last_n_completed: z.number().min(1).max(100).optional(),
      },
    },
    async (args, _extra) => {
      const text = await handleReadProgress(progressPath, args.last_n_completed)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "read_journal",
    {
      description: "Reads the Foreman session journal. Returns session history with rollup.",
      inputSchema: {
        last_n: z.number().min(1).max(100).optional(),
        rollup_only: z.boolean().optional(),
      },
    },
    async (args, _extra) => {
      const journal = await readJournal(journalPath)
      if (args.rollup_only) {
        return { content: [{ type: "text" as const, text: JSON.stringify(journal.rollup ?? null) }] }
      }
      if (args.last_n) {
        const sliced = { ...journal, sessions: journal.sessions.slice(-args.last_n) }
        return { content: [{ type: "text" as const, text: JSON.stringify(sliced) }] }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(journal) }] }
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
    "invoke_advisor",
    {
      description: "Invoke codex|gemini CLI via stdin. Resolves binary cross-platform, wraps .cmd shims on win32.",
      inputSchema: {
        cli: z.enum(["codex", "gemini"]),
        prompt: z.string().max(100000),
        timeout_ms: z.number().min(5000).max(600000).default(300000),
      },
    },
    async (args, _extra) => {
      const result = await invokeAdvisor(args.cli, args.prompt, args.timeout_ms)
      const text = formatAdvisorResult(args.cli, result)
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
        "  set_phase_scope — Declare phase scope for gate applicability. data: { has_tests, has_api, has_build: boolean }. Requires: phase.",
      ].join("\n"),
      inputSchema: {
        operation: z.enum(["set_unit_status", "set_verdict", "add_rejection", "update_phase_gate", "set_phase_scope"]),
        unit_id: z.string().max(10000).optional(),
        phase: z.string().max(10000).optional(),
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
      const text = await handleWriteProgress(progressPath, args, docsDir, ledgerPath)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "write_journal",
    {
      description: "Writes to the Foreman session journal. Operations: init_session — start session with env; log_event — append operational event; end_session — finalize with summary.",
      inputSchema: {
        operation: z.enum(["init_session", "log_event", "end_session"]),
        data: z.record(z.unknown()),
      },
    },
    async (args, _extra) => {
      const input = { operation: args.operation, data: args.data } as any
      if (args.operation === "init_session") {
        const journal = await initSession(journalPath, input)
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, session_id: journal.sessions[journal.sessions.length - 1].id }) }] }
      } else if (args.operation === "log_event") {
        const result = await logEvent(journalPath, input)
        return { content: [{ type: "text" as const, text: result }] }
      } else {
        const journal = await endSession(journalPath, input)
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, sessions: journal.sessions.length, rollup: !!journal.rollup }) }] }
      }
    }
  )

  server.registerTool(
    "normalize_review",
    {
      description: "Normalizes raw review text into structured findings.",
      inputSchema: NormalizeReviewInputSchema.shape,
    },
    async (args, _extra) => {
      const { text } = normalizeReview(args.reviewer, args.raw_text)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "run_tests",
    {
      description: "Runs a test command with bounded output. Runner must be in allowlist (npm, pytest, go, cargo, dotnet, make). Use instead of Bash for test execution.",
      inputSchema: {
        runner: z.string().min(1).max(50),
        args: z.array(z.string().max(10000)).max(100).default([]),
        timeout_ms: z.number().min(1).max(600000).optional(),
        max_output_chars: z.number().min(1).max(50000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await runTests(args.runner, args.args, args.timeout_ms, args.max_output_chars)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "session_orient",
    {
      description: "Returns current Foreman session state: current phase, unit, next pending, blocked status. Call at session start for orientation.",
    },
    async (_extra) => {
      const text = await sessionOrient(ledgerPath, progressPath)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  // ── Skill Resources ────────────────────────────────────────────────────────

  async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true } catch { return false }
  }

  // Resolve skills directory — works from both src/ (dev) and dist/ (production)
  let skillsDir = path.resolve(__dirname, "skills")
  if (!await fileExists(skillsDir)) {
    skillsDir = path.resolve(__dirname, "..", "src", "skills")
  }

  // ── Skill Activation Tools ──────────────────────────────────────────────────

  server.registerTool(
    "pitboss_implementor",
    {
      description: [
        "Activates the Foreman pitboss-implementor protocol.",
        "Returns the full orchestration skill: pit-boss/worker pattern,",
        "spec-driven validation, gates G1–G5, and Codex/Gemini deliberation",
        "(falls back to Opus agents when external CLIs are unavailable).",
        "The LLM MUST follow the returned instructions to orchestrate implementation.",
        "Pass optional context to indicate resume state or handoff path.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateImplementor(skillsDir, args.context)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "design_partner",
    {
      description: [
        "Activates the Foreman design-partner protocol.",
        "Collaborative engineering design session that pushes back on vague requirements,",
        "forces decisions on ambiguities, and runs multi-model deliberation.",
        "Produces Docs/design-summary.md. First stage of the Foreman pipeline.",
        "The LLM MUST follow the returned instructions to run the design session.",
        "Pass optional context to describe the project or problem being designed.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateDesignPartner(skillsDir, args.context)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "spec_generator",
    {
      description: [
        "Activates the Foreman spec-generator protocol.",
        "Transforms a design summary into formal implementation documents:",
        "spec.md, handoff.md, PROGRESS.md, testing-harness.md.",
        "Seeds the Foreman ledger and progress tracker. Second stage of the Foreman pipeline.",
        "The LLM MUST follow the returned instructions to generate spec documents.",
        "Pass optional context to indicate the design summary source.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateSpecGenerator(skillsDir, args.context)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  // ── Skill Resource Registration ─────────────────────────────────────────────

  let skillFiles: string[] = []
  try {
    const entries = await fs.readdir(skillsDir)
    skillFiles = entries.filter((f) => f.endsWith(".md") && !f.startsWith("_"))
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
        try {
          const result = await loadSkill(name, skillsDir)
          return {
            contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text: result.content }],
          }
        } catch (err) {
          console.error(`[foreman] Resource read failed for "${name}": ${(err as Error).message}`)
          // Fall back to bundled raw + renderIncludes, which is the existing behavior
          const raw = await fs.readFile(filePath, "utf-8")
          const text = await renderIncludes(raw, filePath)
          return {
            contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text }],
          }
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
    const mdFiles = entries.filter((f) => f.endsWith(".md") && !f.startsWith("_"))
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
