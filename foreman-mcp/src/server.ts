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
import { verifyCitations } from "./tools/verifyCitations.js"
import { runTests } from "./tools/runTests.js"
import { activateImplementor } from "./tools/activateImplementor.js"
import { activateDesignPartner } from "./tools/activateDesignPartner.js"
import { activateSpecGenerator } from "./tools/activateSpecGenerator.js"
import { activateLighttask } from "./tools/activateLighttask.js"
import { activateSpecMan } from "./tools/activateSpecMan.js"
import { activateDocMan } from "./tools/activateDocMan.js"
import { previewDiagram } from "./tools/previewDiagram.js"
import { closeDiagramServer } from "./lib/diagramServer.js"
import { NormalizeReviewInputSchema, VerifyCitationsInputSchema } from "./types.js"
import { readJournal, initSession, logEvent, endSession } from "./lib/journal.js"
import { invokeAdvisor, formatAdvisorResult } from "./tools/invokeAdvisor.js"
import { sessionOrient } from "./tools/sessionOrient.js"
import { renderIncludes, loadSkill } from "./lib/skillLoader.js"
import { hostStatus } from "./tools/hostStatus.js"
import { type HostId, resolveHost, parseHostFlag, getProfile } from "./lib/hostProfiles.js"
import { maybeCompress, compressionEnabled, getRetrieveOriginalTool } from "./lib/compression.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface ServerConfig {
  ledgerPath?: string
  progressPath?: string
  journalPath?: string
  docsDir?: string
  /**
   * Active host. Controls how skill placeholders ({{worker_invoke}},
   * {{advisor_a}}, {{advisor_b}}) are rendered and how capability_check
   * responds. Default: "claude-code".
   */
  host?: HostId
}

export async function createServer(config?: ServerConfig): Promise<McpServer> {
  const ledgerPath = config?.ledgerPath ?? "Docs/.foreman-ledger.json"
  const progressPath = config?.progressPath ?? "Docs/.foreman-progress.json"
  const docsDir = config?.docsDir ?? "Docs"
  const journalPath = config?.journalPath ?? "Docs/.foreman-journal.json"
  const host: HostId = config?.host ?? "claude-code"

  const server = new McpServer(
    { name: "foreman", version: "0.3.0" },
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
    "host_status",
    {
      description: "Returns the active Foreman host and the model slugs used for worker / advisor invocation. Use to confirm whether skills are rendered for Claude Code, Cursor, or another host.",
    },
    async (_extra) => {
      const text = hostStatus(host)
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
      description: "Checks whether codex or gemini CLI is available. In cursor host mode, returns a synthetic available response (Task subagent is always reachable).",
      inputSchema: {
        cli: z.enum(["codex", "gemini"]),
      },
    },
    async (args, _extra) => {
      const text = await capabilityCheck(args.cli, host)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "invoke_advisor",
    {
      description: "Invoke codex|gemini CLI via stdin. Resolves binary cross-platform, wraps .cmd shims on win32. Failed calls may be compressed; if a failed call's summary is insufficient, call retrieve_original with the <<ccr:HASH>> marker for the full diagnostic.",
      inputSchema: {
        cli: z.enum(["codex", "gemini"]),
        prompt: z.string().max(100000),
        timeout_ms: z.number().min(5000).max(600000).default(300000),
      },
    },
    async (args, _extra) => {
      const result = await invokeAdvisor(args.cli, args.prompt, args.timeout_ms)
      const formatted = formatAdvisorResult(args.cli, result)
      // Successful advisor output is PROSE — never lossy-compress it (silent loss of the
      // recommendations). A FAILED call is an unpredictable diagnostic dump: let the normal
      // compression path handle it; the agent sees exit_code != 0 and can retrieve_original.
      const text = result.exitCode === 0 ? formatted : maybeCompress("invoke_advisor", formatted)
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
        "  set_unit_status — Set a unit's status. data: { s: 'pending'|'ip'|'delegated'|'done'|'fail', brief?: string }. Requires: phase, unit_id. s:'delegated' requires a 'brief' (min 20 chars) summarizing the worker brief.",
        "  set_verdict     — Record pass/fail verdict. data: { v: 'pass'|'fail'|'pending', via?, note? }. Requires: phase, unit_id. v:'pass' is blocked unless the unit was first set to s:'delegated' with a brief; if phase scope declares has_tests:false or has_build:false, a non-empty attestation 'note' is also required.",
        "  add_rejection   — Log a rejection. data: { r: string, msg: string, ts: string }. Requires: phase, unit_id.",
        "  update_phase_gate — Set phase gate result. data: { g: 'pass'|'fail'|'pending' }. Requires: phase. g:'pass' is blocked unless every unit in the phase has verdict 'pass'.",
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
    "verify_citations",
    {
      description:
        "Verifies that evidence citations reference real files and that any verbatim anchor appears at or near the cited line. Reports location and presence only (CONFIRMED/DRIFTED/MISSING/UNANCHORED/...); does not judge whether the line supports the claim. Reads files under repo_root; deterministic and read-only.",
      inputSchema: VerifyCitationsInputSchema.shape,
    },
    async (args, _extra) => {
      const { text } = await verifyCitations(args)
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
      const text = maybeCompress("run_tests", await runTests(args.runner, args.args, args.timeout_ms, args.max_output_chars))
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

  // retrieve_original ships with compression, which is DEFAULT ON for the 0.2.0 pilot
  // (kill switch FOREMAN_COMPRESSION=0 — markers can't exist when compression is off,
  // so the tool unregisters with it).
  if (compressionEnabled()) {
    const tool = getRetrieveOriginalTool()
    server.registerTool(
      tool.name,
      {
        description: tool.description + " Use this whenever a compressed result (it carries a <<ccr:HASH>> marker) may be missing detail you need — e.g. a failed advisor or test call whose summary looks insufficient.",
        inputSchema: {
          hash: z.string().regex(/^[0-9a-f]{24}$/).describe("The 24 lowercase hex characters from a <<ccr:HASH>> marker."),
        },
      },
      async (args, _extra) => {
        const result = tool.handler({ hash: args.hash })
        if ("original" in result) {
          return { content: [{ type: "text" as const, text: result.original }] }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true }
      }
    )
  }

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
        "Use for larger multi-phase implementation from prepared specs, especially",
        "worker fan-out, gate routing, retries, recovery, blocked work, or multi-session resume.",
        "Flags when optional LangGraph-style runtime control may be warranted while",
        "keeping Foreman specs, ledger, journal, tests, and advisor decisions canonical.",
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
      const text = await activateImplementor(skillsDir, args.context, host)
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
      const text = await activateDesignPartner(skillsDir, args.context, host)
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
      const text = await activateSpecGenerator(skillsDir, args.context, host)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "lighttask",
    {
      description: [
        "Activates the Foreman lighttask protocol.",
        "Default for small surgical work where classic Foreman is enough; avoid for",
        "long-running branching multi-worker workflows unless escalating.",
        "Lightweight surgical-task workflow with workspace classification,",
        "git context, spec freshness, Atlas/code-surfacing grounding, mandatory adversarial review,",
        "bypass waivers, and compact execution tracking.",
        "Escalates to spec_man when specs are missing, stale, partial, or repo changes require",
        "Plan Delta Ladder re-evaluation before implementation.",
        "The LLM MUST follow the returned instructions to run the lighttask session.",
        "Pass optional context to describe the task or target repo.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateLighttask(skillsDir, args.context, host)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "spec_man",
    {
      description: [
        "Activates the Foreman spec-man protocol.",
        "Produces focused intended-behavior specs and machine specs from user intent,",
        "tickets, existing specs, code evidence, contracts, discovery output, or external docs.",
        "Use for existing-repo/spec re-evaluation, stale-plan detection, Atlas/Graphify",
        "code-surfacing, and Plan Delta Ladder grouping (D3 raw, D2 grouped, D1 candidate,",
        "D0 current). Never auto-promote D1 to D0 without recorded approval.",
        "The LLM MUST follow the returned instructions to generate grounded specs.",
        "Pass optional context to describe the feature, subsystem, or source material.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateSpecMan(skillsDir, args.context, host)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "doc_man",
    {
      description: [
        "Activates the Foreman doc-man protocol.",
        "Generates focused technical documentation from spec-man output,",
        "project atlas or discovery output, source code, existing docs, and command output.",
        "Supports README, architecture, data-flow, Mermaid, Confluence, and machine-doc modes.",
        "The LLM MUST follow the returned instructions to generate grounded documentation.",
        "Pass optional context to describe the document target or style needs.",
      ].join(" "),
      inputSchema: {
        context: z.string().max(10000).optional(),
      },
    },
    async (args, _extra) => {
      const text = await activateDocMan(skillsDir, args.context, host)
      return { content: [{ type: "text" as const, text }] }
    }
  )

  server.registerTool(
    "preview_diagram",
    {
      description: [
        "Render a Mermaid diagram into a LIVE, auto-refreshing browser preview the user can watch.",
        "Writes the source to Docs/diagrams/<id>.mmd (the versioned artifact) and serves it on a",
        "loopback-only (127.0.0.1), token-gated, Host-validated HTTP server; mermaid renders",
        "client-side (no Chromium) and the tab live-reloads whenever the diagram changes.",
        "Fully offline — no data leaves the machine. Use this to SHOW the user a data flow,",
        "architecture, sequence, state, class, or ER diagram instead of dumping raw Mermaid text.",
        "Call again with the same id (or edit the .mmd directly) to update the preview in place.",
        "Pass source to create/replace the diagram; omit source to re-open an existing one.",
        "Note: architecture-beta and mindmap are not supported under the strict render policy.",
      ].join(" "),
      inputSchema: {
        source: z.string().min(1).max(50000).optional(),
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase slug, no slashes")
          .optional(),
        title: z.string().max(120).optional(),
        theme: z.enum(["default", "neutral", "dark", "forest", "base"]).optional(),
        open: z.boolean().optional(),
      },
    },
    async (args, _extra) => {
      const result = await previewDiagram(args, docsDir)
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      }
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
          const result = await loadSkill(name, skillsDir, host)
          return {
            contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text: result.content }],
          }
        } catch (err) {
          console.error(`[foreman] Resource read failed for "${name}": ${(err as Error).message}`)
          // Fall back to bundled raw + renderIncludes, which is the existing behavior.
          // Note: host placeholders won't be substituted on this fallback path; the
          // failure case is rare (skill load error) and the unrendered placeholders
          // are still readable text.
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
     \x1b[2mCopyright (c) 2026 Malinda Rathnayake — Apache-2.0\x1b[0m
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

  // Resolve host once: --host flag wins, then FOREMAN_HOST env, then default.
  const flagHost = parseHostFlag(args)
  const host = resolveHost({ flag: flagHost, env: process.env.FOREMAN_HOST ?? null })

  if (args.includes("--version") || args.includes("-v")) {
    await printVersion()
    console.log(`  host: ${host} (${getProfile(host).displayName})`)
    process.exit(0)
  } else if (args.includes("--diag")) {
    runDiag().then(() => process.exit(0)).catch((e) => {
      console.error("Diag failed:", e)
      process.exit(1)
    })
  } else if (process.stdin.isTTY) {
    // Interactive terminal with no flags — print version and usage hint
    await printVersion()
    console.log(`  host: ${host} (${getProfile(host).displayName})`)
    console.log("Usage:")
    console.log("  foreman-mcp                      Start MCP server (stdin/stdout)")
    console.log("  foreman-mcp --host=<id>          Set host: claude-code (default), cursor, codex")
    console.log("  foreman-mcp --version            Print version and exit")
    console.log("  foreman-mcp --diag               Run diagnostics and exit")
    console.log("Env vars:")
    console.log("  FOREMAN_HOST                     Same effect as --host=<id> (flag wins)")
    process.exit(0)
  } else {
    // Non-TTY stdin — MCP client is connecting, start the server
    console.error(`[foreman] starting MCP server (host=${host})`)
    createServer({ host }).then(async (server) => {
      const transport = new StdioServerTransport()

      // Graceful shutdown. The preview_diagram tool may start a loopback HTTP
      // listener (a ref'd handle) that would otherwise keep this process alive
      // after the MCP client disconnects. Tear it down on stdin EOF / signals so
      // the process exits and the port is released. No-op if no preview started.
      let shuttingDown = false
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return
        shuttingDown = true
        try {
          await closeDiagramServer()
        } catch {
          /* ignore */
        }
        try {
          await server.close()
        } catch {
          /* ignore */
        }
        process.exit(0)
      }
      process.stdin.on("end", shutdown)
      process.stdin.on("close", shutdown)
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)

      await server.connect(transport)
    })
  }
}
