#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

import { bundleStatus } from "./tools/bundleStatus.js"
import { captureRuntimeSnapshot, type RuntimeSnapshot } from "./lib/runtimeSnapshot.js"
import { changelog } from "./tools/changelog.js"
import { ethos, ETHOS_SECTIONS } from "./tools/ethos.js"
import { resolveStackProfile } from "./lib/stackProfiles.js"
import { handleReadLedger } from "./tools/readLedger.js"
import { handleReadProgress } from "./tools/readProgress.js"
import { capabilityCheck } from "./tools/capabilityCheck.js"
import { handleWriteLedger } from "./tools/writeLedger.js"
import { handleWriteProgress } from "./tools/writeProgress.js"
import { handleInvokeWorker } from "./tools/invokeWorker.js"
import { handleRepoGuard } from "./tools/repoGuard.js"
import { handleInvokeCouncil } from "./tools/invokeCouncil.js"
import { LENS_IDS, LENS_CATALOG } from "./lib/lensCatalog.js"
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
import {
  NormalizeReviewInputSchema,
  VerifyCitationsInputSchema,
  JournalOperationDataSchemas,
  LedgerOperationDataSchemas,
  ProgressOperationDataSchemas,
} from "./types.js"
import { renderShape } from "./lib/schemaDoc.js"
import { formatSchemaError, isZodError } from "./lib/schemaError.js"
import { readJournal, initSession, logEvent, endSession } from "./lib/journal.js"
import { invokeAdvisor, formatAdvisorResult, GEMINI_ADVISOR_MODEL, CODEX_ADVISOR_MODEL } from "./tools/invokeAdvisor.js"
import { sessionOrient } from "./tools/sessionOrient.js"
import { renderIncludes, loadSkill } from "./lib/skillLoader.js"
import { hostStatus } from "./tools/hostStatus.js"
import { type HostId, resolveHost, parseHostFlag, getProfile } from "./lib/hostProfiles.js"
import { maybeCompress, compressionEnabled, getRetrieveOriginalTool, toolNameForHash } from "./lib/compression.js"
import { ADVISOR_CLIS } from "./lib/advisorCli.js"
import { codexAgentsInit, CODEX_AGENT_ROLES } from "./tools/codexAgentsInit.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TextOutputSchema = z.string()

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: text,
    ...(isError ? { isError: true } : {}),
  }
}

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

  // Stack profile resolves once per process, like host: env wins, then the
  // project override file <docsDir>/foreman-stack-profile.md, then bundled reference.
  const stackProfile = await resolveStackProfile({
    env: process.env.FOREMAN_STACK_PROFILE ?? null,
    docsDir,
  })

  // Version comes from package.json — the single source; releaseInvariants.test.ts
  // pins package.json === server-reported === CHANGELOG (1g).
  const pkgPath = path.resolve(__dirname, "..", "package.json")
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as { version: string }

  // Process-start snapshot for bundle_status (round 4): dist/, package.json, and the
  // stack profile override, which resolveStackProfile above read once. Failure to snapshot
  // is reported by the tool as n/a, never fatal here.
  let startupSnapshot: RuntimeSnapshot | { error: string }
  try {
    startupSnapshot = await captureRuntimeSnapshot({
      packageRoot: path.resolve(__dirname, ".."),
      extraFiles: [path.resolve(docsDir, "foreman-stack-profile.md")],
    })
  } catch (err) {
    startupSnapshot = { error: (err as Error).message }
  }

  // McpServer v2 installs and advertises capabilities as tools/resources are
  // registered. Avoid declaring empty capabilities up front: that would
  // install eager handlers and can advertise features that are not present.
  const server = new McpServer({ name: "foreman", version: pkg.version })

  // Per-operation data shapes, rendered from the validation schemas. They live in the
  // `data` property's schema description rather than the tool description: the host
  // clips tool descriptions at ~2,000 characters (measured, field feedback 2026-09
  // round 3) but shows the input schema in full.
  const shapesOf = (schemas: Record<string, z.ZodType>): string =>
    Object.entries(schemas).map(([op, s]) => `${op}: ${renderShape(s)}`).join("\n")

  // ── Tools ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "bundle_status",
    {
      title: "Bundle Status",
      description: "Reports the version this process is running versus the package.json on disk next to it, and restart_recommended true/false/n-a from comparing dist/, package.json, and the stack profile override against a snapshot taken at process start (compiled code cannot be reloaded; protocol Markdown is re-read on every activation), plus which skills are shadowed by a project or user override.",
      inputSchema: z.strictObject({}),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Bundle Status",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (_extra) => {
      const text = await bundleStatus(pkg.version, startupSnapshot)
      return textResult(text)
    }
  )

  server.registerTool(
    "host_status",
    {
      title: "Host Status",
      description: "Returns the active Foreman host and the model slugs used for worker / advisor invocation. Use to confirm whether skills are rendered for Claude Code, Cursor, or another host.",
      inputSchema: z.strictObject({}),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Host Status",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (_extra) => {
      const text = hostStatus(host)
      return textResult(text)
    }
  )

  server.registerTool(
    "changelog",
    {
      title: "Changelog",
      description: "Returns the Foreman changelog, optionally since a version.",
      inputSchema: z.strictObject({
        since_version: z.string().max(20).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Changelog",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = changelog(args.since_version)
      return textResult(text)
    }
  )

  server.registerTool(
    "ethos",
    {
      title: "Engineering Ethos",
      description:
        "Serves the canonical engineering-ethos document consumed by the Foreman protocols (proportionality tiers, three pillars, G6 review checklist), rendered with the active stack profile. Pass section to fetch a single ## section.",
      inputSchema: z.strictObject({
        section: z.enum(ETHOS_SECTIONS).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Engineering Ethos",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await ethos(stackProfile, args.section)
      return textResult(text)
    }
  )

  server.registerTool(
    "read_ledger",
    {
      title: "Read Ledger",
      description: "Reads the Foreman ledger with bounded output. Table queries are paged (cursor/limit, max 100), phase-filterable, and omit verdict notes unless include_notes:true. Oversized full/metrics reads return guidance instead of flooding host context. Query 'delegation_metrics' derives worker-delegation metrics from the events sidecar.",
      inputSchema: z.strictObject({
        unit_id: z.string().max(10000).optional(),
        phase: z.string().max(10000).optional(),
        query: z.enum(["verdicts", "rejections", "phase_gates", "reviews", "full", "delegation_metrics"]).optional(),
        verdict: z.enum(["pass", "fail", "pending", "inconclusive"]).optional(),
        include_notes: z.boolean().optional(),
        cursor: z.number().int().min(0).max(1000000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Read Ledger",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await handleReadLedger(ledgerPath, args)
      return textResult(text)
    }
  )

  server.registerTool(
    "read_progress",
    {
      title: "Read Progress",
      description: "Reads the descriptive Foreman planning checklist. It is not resume authority; call session_orient to choose the next action.",
      inputSchema: z.strictObject({
        last_n_completed: z.number().min(1).max(100).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Read Progress",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await handleReadProgress(progressPath, args.last_n_completed)
      return textResult(text)
    }
  )

  server.registerTool(
    "read_journal",
    {
      title: "Read Journal",
      description: "Reads the Foreman session journal. Returns session history with rollup.",
      inputSchema: z.strictObject({
        last_n: z.number().min(1).max(100).optional(),
        rollup_only: z.boolean().optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Read Journal",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const journal = await readJournal(journalPath)
      if (args.rollup_only) {
        return textResult(JSON.stringify(journal.rollup ?? null))
      }
      if (args.last_n) {
        const sliced = { ...journal, sessions: journal.sessions.slice(-args.last_n) }
        return textResult(JSON.stringify(sliced))
      }
      return textResult(JSON.stringify(journal))
    }
  )

  server.registerTool(
    "capability_check",
    {
      title: "Capability Check",
      description:
        host === "cursor"
          ? "Returns synthetic availability for Cursor's codex/gemini advisor seats. An explicit claude check probes the local Claude CLI."
          : "Checks whether the claude, codex, or gemini CLI is available and authenticated. Returns a closed auth_status taxonomy (ok|not_found|not_trusted|auth_expired|probe_timeout|model_substituted|error) with a corrective hint on failures. For gemini it also reports model_requested and model_served from the run stats; a served model other than the pinned one is model_substituted.",
      inputSchema: z.strictObject({
        cli: z.enum(ADVISOR_CLIS),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Capability Check",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await capabilityCheck(args.cli, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "invoke_advisor",
    {
      title: "Invoke Advisor",
      description: "Invoke claude|codex|gemini CLI via stdin. Resolves binaries cross-platform and wraps .cmd shims on win32. Claude runs headless with Fable 5 at max effort and no tools; Codex runs gpt-6-astra at xhigh reasoning (codex-cli 0.153.4 or newer) and the meta block echoes model_served and reasoning_effort from its header. Exit 0 with empty stdout, or stdout equal to the prompt, is reported as completion: failed with the stderr tail — not a clean seat; record it as failed and retry once. Gemini runs with JSON output: the meta block names model_requested and model_served, and a served model other than the pinned one is completion: failed (model_substituted). Failed calls may be compressed; if a failed call's summary is insufficient, call retrieve_original with the <<ccr:HASH>> marker for the full diagnostic.",
      inputSchema: z.strictObject({
        cli: z.enum(ADVISOR_CLIS),
        prompt: z.string().max(100000),
        // Newer Sol-class models at xhigh reasoning effort routinely think for
        // >5 min on large review prompts — budget 15 min by default, cap at 30.
        timeout_ms: z.number().min(5000).max(1800000).default(900000),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Invoke Advisor",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const result = await invokeAdvisor(args.cli, args.prompt, args.timeout_ms)
      const pinned = args.cli === "gemini" ? GEMINI_ADVISOR_MODEL : args.cli === "codex" ? CODEX_ADVISOR_MODEL : undefined
      const formatted = formatAdvisorResult(args.cli, result, args.prompt, pinned)
      // Successful advisor output is PROSE — never lossy-compress it (silent loss of the
      // recommendations). A FAILED call is an unpredictable diagnostic dump: let the normal
      // compression path handle it; the agent sees exit_code != 0 and can retrieve_original.
      const text = result.exitCode === 0 ? formatted : maybeCompress("invoke_advisor", formatted)
      return textResult(text)
    }
  )

  server.registerTool(
    "write_ledger",
    {
      title: "Write Ledger",
      description: [
        "Writes one operation to the Foreman ledger. Per-operation data shapes are in the input schema (data field description); a rejected call returns one hint per field plus the expected shape.",
        "",
        "Operations (phase required; unit_id where noted):",
        "  set_unit_status (unit_id) — s:'delegated' needs a brief (≥20 chars) and a preflight attestation; s:'ip' with direct_fix records a literal fix as an attempt. Past 3 failed attempts since the last pass, an attempt needs an open grant or user_override.",
        "  set_verdict (unit_id) — v:'pass' needs a prior delegation, an attempt after the latest failure (ATTEMPT REQUIRED), past the cap a granted/overridden attempt or user_override (cap_override), and on a no-test/no-build phase a ≥5-word note; v:'fail' counts as a failed attempt.",
        "  add_rejection (unit_id) — counts a failed attempt; reopens a passed unit to 'pending'.",
        "  authorize_attempts (unit_id) — the owner's decision, once: N more attempts past the cap, charged per attempt; refused below the cap or while a grant is open; a pass closes it.",
        "  declare_phase_units — additive declared id set (cap 200); retire needs a reason; frozen once the gate is 'pass'.",
        "  update_phase_gate — g:'pass' needs every unit passed, every declared id registered, and a current independent review (or eligible verification; cross_exam never counts) with no 'confirmed' finding and no partial, failed, or silent record without checked[]; user_override waives the review conditions (recorded on the phase).",
        "  set_phase_scope — once per phase; hot_path/security_boundary make the gate require agent_class:'frontier'.",
        "  record_review — every finding needs a classification; 'line' is a string, severity lowercase; zero findings need checked[] or completion:'complete'; 'confirmed' blocks the gate; stage:'verification' (direct-fix re-verdicts only) needs completion:'complete' + evidence. Limit: checked ≤50 entries of ≤400 chars.",
      ].join("\n"),
      inputSchema: z.strictObject({
        operation: z.enum(["set_unit_status", "set_verdict", "add_rejection", "declare_phase_units", "update_phase_gate", "set_phase_scope", "record_review", "authorize_attempts"]),
        unit_id: z.string().max(10000).optional(),
        phase: z.string().max(10000).optional(),
        data: z.record(z.string(), z.unknown()).describe(
          "Per-operation shape (every key, enum value, and limit):\n" + shapesOf(LedgerOperationDataSchemas)
        ),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Write Ledger",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await handleWriteLedger(ledgerPath, args)
      return textResult(text)
    }
  )

  server.registerTool(
    "invoke_worker",
    {
      title: "Invoke Patch Worker (EXPERIMENTAL)",
      description: [
        "EXPERIMENTAL. Delegates a single patch task to the remote OpenAI-compatible",
        "chat-completions endpoint configured in .foremanenv, at the requested cost tier.",
        "EGRESS BOUNDARY: sends the brief and the listed file contents to that endpoint —",
        "review .foremanenv routing before delegating sensitive code. An outbound secret",
        "gate blocks the request if any configured secret value appears in the payload.",
        "One-shot: no retries beyond a single automatic reasoning_effort downgrade if the",
        "endpoint rejects that parameter. Returns the worker's patch VERBATIM between",
        "-----BEGIN FOREMAN PATCH----- / -----END FOREMAN PATCH----- sentinels together with",
        "base_file_hashes for a content-addressed staleness check; the HOST applies the patch,",
        "never Foreman. Every outcome is classified into a closed failure-stage taxonomy and",
        "recorded in the hash-chained event sidecar. Requires the unit to already be recorded",
        "as s:'delegated' in the ledger (invoke_worker never writes the ledger).",
      ].join(" "),
      inputSchema: z.strictObject({
        phase: z.string().max(10000),
        unit_id: z.string().max(10000),
        brief: z.string(),
        tier: z.enum(["cheap", "standard", "premium"]),
        files: z.array(z.string()).max(100),
        edit_format: z.enum(["unified_diff", "search_replace", "whole_file"]).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Invoke Patch Worker (EXPERIMENTAL)",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, _extra) => {
      const text = await handleInvokeWorker(args, { docsDir, ledgerPath, journalPath })
      return textResult(text)
    }
  )

  server.registerTool(
    "repo_guard",
    {
      title: "Repository Guard",
      description:
        "Runs the shared-tree ownership check around an editing worker and records it on the unit's newest delegation. 'snapshot' captures repository root, branch, HEAD, stash, every changed path with a content fingerprint, core.autocrlf, and line-ending attributes before the worker runs, and freezes allowed_files onto that baseline; 'compare' re-reads the state afterwards and names every mutation outside the frozen set — a moved HEAD, a touched index or stash, a changed config, a file changed outside the brief, an already-dirty file whose content was overwritten, or a pre-existing uncommitted change that disappeared. Foreman writes both results, so set_verdict refuses a pass whose guard did not clear (REPOSITORY GUARD). A baseline cannot be re-taken for an attempt that has one, and compare takes no allowed_files of its own. Any git probe that fails, times out, or truncates is a refusal, never a clean tree. Outside a git work tree it reports n/a and gates nothing. Order: set_unit_status s:'delegated' -> snapshot -> spawn the worker -> compare -> set_verdict.",
      inputSchema: z.strictObject({
        operation: z.enum(["snapshot", "compare"]),
        phase: z.string().min(1).max(10000),
        unit_id: z.string().min(1).max(10000),
        files: z.array(z.string().max(4096)).max(100).optional()
          .describe("The unit's files, for the line-ending probe. Relative paths inside the project."),
        allowed_files: z.array(z.string().max(4096)).max(100).optional()
          .describe("snapshot only: the files the brief authorized, frozen onto the baseline. A change outside this set is a violation. Refused on compare."),
        project_dir: z.string().min(1).optional().describe("Repository root (default: process.cwd())"),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Repository Guard",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await handleRepoGuard(args, { ledgerPath })
      return textResult(text)
    }
  )

  server.registerTool(
    "invoke_council",
    {
      title: "Invoke Review Council (EXPERIMENTAL)",
      description: [
        "EXPERIMENTAL. Convenes an adaptive review council: N remote review seats (configured as",
        "FOREMAN_COUNCIL_SEAT_<A|B|C> in .foremanenv) x M risk lenses, run in parallel against ONE",
        "evidence packet, each returning structured findings. READ-ONLY — seats inspect and report;",
        "they never edit the tree, apply fixes, or write the ledger.",
        "EGRESS BOUNDARY: sends the objective, evidence, and any listed file contents to the",
        "configured endpoint. An outbound secret gate blocks the request if any configured secret",
        "value appears in the payload.",
        "This tool does NOT decide. It reports per-seat findings, cross-seat agreement COUNTS (never",
        "a merged verdict), limitations, and failed seats; YOU moderate and the USER arbitrates.",
        "A failed, partial, or unparseable seat is never an approval. With no seats configured it",
        "returns status: unavailable and names the next rung of the deliberation ladder.",
        `Lenses: ${LENS_IDS.map((id) => `${id} (${LENS_CATALOG[id].question})`).join("; ")}.`,
      ].join(" "),
      inputSchema: z.strictObject({
        phase: z.string().max(10000),
        objective: z.string().min(10).max(2000),
        evidence: z.string().min(1),
        lenses: z.array(z.enum(LENS_IDS)).max(LENS_IDS.length).optional(),
        seats: z.array(z.enum(["a", "b", "c"])).max(3).optional(),
        files: z.array(z.string()).max(50).optional(),
        cross_examine: z.boolean().optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Invoke Review Council (EXPERIMENTAL)",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, _extra) => {
      const text = await handleInvokeCouncil(args, { journalPath })
      return textResult(text)
    }
  )

  server.registerTool(
    "write_progress",
    {
      title: "Write Progress",
      description: [
        "Writes an operation to the Foreman progress file.",
        "",
        "Operations:",
        "  start_phase   — Initialize a new phase. data: { phase: string, name: string }.",
        "  update_status — Set unit status. data: { unit_id: string, phase: string, status: string, notes: string }.",
        "  complete_unit — Mark unit done. data: { unit_id: string, phase: string, completed_at: string, notes: string }.",
        "  log_error     — Log an error. data: { date: string, unit: string, what_failed: string, next_approach: string }.",
        "",
        "Markdown side effect: when Docs/PROGRESS.md exists, the block between <!-- foreman:checklist-start --> and <!-- foreman:checklist-end --> is REPLACED with a checklist rendered from the LEDGER (unit ids, verdicts, notes; natural order). Content outside the fences is preserved verbatim; with no fences the block is appended at EOF. Keep hand-written unit plans (files, checkpoint commands) outside the fences — they do not survive inside. Seed the ledger before the first call or the block renders '_No phases yet._'. complete_unit also counts hand-written checkbox lines outside the fences that name the unit (legacy_checkbox_candidates) and leaves them untouched.",
        "Exact data shapes for every operation are in this tool's input schema (the description of the data field).",
      ].join("\n"),
      inputSchema: z.strictObject({
        operation: z.enum(["update_status", "complete_unit", "log_error", "start_phase"]),
        data: z.record(z.string(), z.unknown()).describe(
          "Per-operation shape (every key, enum value, and limit):\n" + shapesOf(ProgressOperationDataSchemas)
        ),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Write Progress",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await handleWriteProgress(progressPath, args, docsDir, ledgerPath)
      return textResult(text)
    }
  )

  server.registerTool(
    "write_journal",
    {
      title: "Write Journal",
      description: [
        "Writes to the Foreman session journal — a friction log, not a diary.",
        "",
        "Sequence per session: init_session (once, at session start) → log_event (0–200 entries, anomalies only) → end_session (once, at checkpoint or handoff).",
        "The event-code enum is anomaly-only by design: log failures, delays, and degraded tooling; never successes, worker spawns, or test passes. Host tooling that is broken or unusable (e.g. run_tests cannot spawn) is TOOL_ERR. There is no informational code.",
        "",
        "Exact data shapes for every operation are in this tool's input schema (the description of the data field); a rejected call returns one hint per field plus the expected shape.",
        "Limit: log_event data.msg is at most 400 characters.",
      ].join("\n"),
      inputSchema: z.strictObject({
        operation: z.enum(["init_session", "log_event", "end_session"]),
        data: z.record(z.string(), z.unknown()).describe(
          "Per-operation shape (every key, enum value, and limit):\n" + shapesOf(JournalOperationDataSchemas)
        ),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Write Journal",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const input = { operation: args.operation, data: args.data } as any
      try {
        if (args.operation === "init_session") {
          const journal = await initSession(journalPath, input)
          return textResult(JSON.stringify({ ok: true, session_id: journal.sessions[journal.sessions.length - 1].id }))
        } else if (args.operation === "log_event") {
          const result = await logEvent(journalPath, input)
          return textResult(result)
        } else {
          const journal = await endSession(journalPath, input)
          return textResult(JSON.stringify({ ok: true, sessions: journal.sessions.length, rollup: !!journal.rollup }))
        }
      } catch (err) {
        // One line per field + the expected shape, instead of a raw Zod issue dump.
        if (isZodError(err)) throw new Error(formatSchemaError("write_journal", err, input, JournalOperationDataSchemas))
        throw err
      }
    }
  )

  server.registerTool(
    "normalize_review",
    {
      title: "Normalize Review",
      description: "Normalizes raw review text into structured findings.",
      inputSchema: NormalizeReviewInputSchema,
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Normalize Review",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const { text } = normalizeReview(args.reviewer, args.raw_text)
      return textResult(text)
    }
  )

  server.registerTool(
    "verify_citations",
    {
      title: "Verify Citations",
      description:
        "Verifies that evidence citations reference real files and that any verbatim anchor appears at or near the cited line. Reports location and presence only (CONFIRMED/DRIFTED/MISSING/UNANCHORED/...); does not judge whether the line supports the claim. Reads files under repo_root; deterministic and read-only.",
      inputSchema: VerifyCitationsInputSchema,
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Verify Citations",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const { text } = await verifyCitations(args)
      return textResult(text)
    }
  )

  server.registerTool(
    "run_tests",
    {
      title: "Run Tests",
      description: [
        "Runs a test command with bounded output. Runner must be in allowlist (npm, pytest, go, cargo, dotnet, make, gradle, gradlew, gofmt, golangci-lint; extend with FOREMAN_TEST_ALLOWLIST; npx never). Project-local Gradle wrappers are supported without shell or cmd.exe interpolation. Use instead of Bash for test execution.",
        "passed is exit code 0. List-style checkers such as gofmt -l exit 0 and print the files needing work: pass fail_on_stdout:true so any stdout counts as a failure. Output shaping: truncation always keeps the TAIL of each stream. strip_patterns (≤10 JS regex sources, per line, both streams, before the cap) drops known noise and reports stripped_lines; tail_lines keeps the last N lines. All opt-in; default output is unchanged.",
      ].join("\n"),
      inputSchema: z.strictObject({
        runner: z.string().min(1).max(50),
        args: z.array(z.string().max(10000)).max(100).default([]),
        timeout_ms: z.number().min(1).max(600000).optional(),
        max_output_chars: z.number().min(1).max(50000).optional(),
        strip_patterns: z.array(z.string().min(1).max(200)).max(10).optional(),
        tail_lines: z.number().int().min(1).max(5000).optional(),
        fail_on_stdout: z.boolean().optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Run Tests",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = maybeCompress(
        "run_tests",
        await runTests(args.runner, args.args, args.timeout_ms, args.max_output_chars, {
          stripPatterns: args.strip_patterns,
          tailLines: args.tail_lines,
          failOnStdout: args.fail_on_stdout,
        })
      )
      return textResult(text)
    }
  )

  server.registerTool(
    "session_orient",
    {
      title: "Session Orient",
      description: "Returns ledger-authoritative Foreman resume state, including action, resume target, phase/unit, gate retry, blockers, and ledger/progress drift. Phase and unit ids order naturally (p2 before p10). last_completed_unit is the completion frontier (newest first-pass timestamp; re-verdicts do not move it); latest_pass_verdict_unit/ts is the newest pass verdict by timestamp. Call first at session start.",
      inputSchema: z.strictObject({}),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Session Orient",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (_extra) => {
      const text = await sessionOrient(ledgerPath, progressPath, host)
      return textResult(text)
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
        title: "Retrieve Original Output",
        description: tool.description + " Use this whenever a compressed result (it carries a <<ccr:HASH>> marker) may be missing detail you need — e.g. a failed advisor or test call whose summary looks insufficient.",
        inputSchema: z.strictObject({
          hash: z.string().regex(/^[0-9a-f]{24}$/).describe("The 24 lowercase hex characters from a <<ccr:HASH>> marker."),
        }),
        outputSchema: TextOutputSchema,
        annotations: {
          title: "Retrieve Original Output",
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
      async (args, _extra) => {
        const result = tool.handler({ hash: args.hash })
        if ("original" in result) {
          return textResult(result.original)
        }
        // Expired-but-known marker: the store dropped the entry (and its stashed toolName),
        // but the Foreman-side map still knows which tool produced it — name the recovery.
        const originTool = toolNameForHash(args.hash)
        if (originTool !== undefined) {
          return textResult(
            JSON.stringify({ error: "ccr_missing_or_expired", hint: `expired — re-run ${originTool} to regenerate the output` }),
            true
          )
        }
        return textResult(JSON.stringify(result), true)
      }
    )
  }

  // Codex-only: write .codex/agents role TOMLs + optional [agents] config for parallel fan-out.
  if (host === "codex") {
    server.registerTool(
      "codex_agents_init",
      {
        title: "Init Codex Agent Roles",
        description: [
          "Writes Codex custom-agent role definitions into the project (.codex/agents/*.toml)",
          "and creates .codex/config.toml with [agents] max_threads/max_depth only when that file is absent.",
          "Existing .codex/config.toml is never overwritten (may hold mcp_servers); a merge hint is returned instead.",
          "explorer/worker TOMLs override Codex built-in roles of those names to pin sandbox_mode.",
          "Model pins are optional — omit to let Codex choose. Call once per project before parallel fan-out.",
        ].join(" "),
        inputSchema: z.strictObject({
          project_dir: z.string().min(1).optional().describe("Project root (default: process.cwd())"),
          max_threads: z.number().int().min(1).max(12).optional().describe("Concurrent agent threads (default 6)"),
          max_depth: z.number().int().min(1).max(3).optional().describe("Nesting depth (default 1; >1 warns)"),
          roles: z.array(z.enum(CODEX_AGENT_ROLES)).min(1).optional().describe("Roles to write (default: explorer, worker)"),
          overwrite: z.boolean().optional().describe("Overwrite existing role TOMLs (default false). Never overwrites config.toml."),
          models: z
            .strictObject({
              explorer: z.string().min(1).optional(),
              worker: z.string().min(1).optional(),
            })
            .optional()
            .describe("Optional per-role model pins; omit to let Codex choose"),
        }),
        outputSchema: TextOutputSchema,
        annotations: {
          title: "Init Codex Agent Roles",
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      async (args, _extra) => {
        const text = await codexAgentsInit(args)
        const isError = text.includes("status: error")
        return textResult(text, isError)
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
      title: "Pitboss Implementor Protocol",
      description: [
        "Activates the Foreman pitboss-implementor protocol.",
        "Use for larger multi-phase implementation from prepared specs, especially",
        "worker fan-out, gate routing, retries, recovery, blocked work, or multi-session resume.",
        "Flags when optional LangGraph-style runtime control may be warranted while",
        "keeping Foreman specs, ledger, journal, tests, and advisor decisions canonical.",
        "Returns the full orchestration skill: pit-boss/worker pattern,",
        "spec-driven validation, gates G1–G6, and Codex/Gemini deliberation",
        "(falls back to Opus agents when external CLIs are unavailable).",
        "The LLM MUST follow the returned instructions to orchestrate implementation.",
        "Pass optional context to indicate resume state or handoff path.",
      ].join(" "),
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Pitboss Implementor Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateImplementor(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "design_partner",
    {
      title: "Design Partner Protocol",
      description: [
        "Activates the Foreman design-partner protocol.",
        "Collaborative engineering design session that pushes back on vague requirements,",
        "forces decisions on ambiguities, and runs multi-model deliberation.",
        "Produces Docs/design-summary.md. First stage of the Foreman pipeline.",
        "The LLM MUST follow the returned instructions to run the design session.",
        "Pass optional context to describe the project or problem being designed.",
      ].join(" "),
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Design Partner Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateDesignPartner(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "spec_generator",
    {
      title: "Spec Generator Protocol",
      description: [
        "Activates the Foreman spec-generator protocol.",
        "Transforms a design summary into formal implementation documents:",
        "spec.md, handoff.md, PROGRESS.md, testing-harness.md.",
        "Seeds the Foreman ledger and progress tracker. Second stage of the Foreman pipeline.",
        "The LLM MUST follow the returned instructions to generate spec documents.",
        "Pass optional context to indicate the design summary source.",
      ].join(" "),
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Spec Generator Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateSpecGenerator(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "lighttask",
    {
      title: "Lighttask Protocol",
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
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Lighttask Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateLighttask(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "spec_man",
    {
      title: "Spec-Man Protocol",
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
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Spec-Man Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateSpecMan(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "doc_man",
    {
      title: "Doc-Man Protocol",
      description: [
        "Activates the Foreman doc-man protocol.",
        "Generates focused technical documentation from spec-man output,",
        "project atlas or discovery output, source code, existing docs, and command output.",
        "Supports README, architecture, data-flow, Mermaid, Confluence, and machine-doc modes.",
        "The LLM MUST follow the returned instructions to generate grounded documentation.",
        "Pass optional context to describe the document target or style needs.",
      ].join(" "),
      inputSchema: z.strictObject({
        context: z.string().max(10000).optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Doc-Man Protocol",
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const text = await activateDocMan(skillsDir, args.context, host)
      return textResult(text)
    }
  )

  server.registerTool(
    "preview_diagram",
    {
      title: "Preview Diagram",
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
      inputSchema: z.strictObject({
        source: z.string().min(1).max(50000).optional(),
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase slug, no slashes")
          .optional(),
        title: z.string().max(120).optional(),
        theme: z.enum(["default", "neutral", "dark", "forest", "base"]).optional(),
        open: z.boolean().optional(),
      }),
      outputSchema: TextOutputSchema,
      annotations: {
        title: "Preview Diagram",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (args, _extra) => {
      const result = await previewDiagram(args, docsDir)
      return textResult(result.text, result.isError)
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
          const result = await loadSkill(name, skillsDir, host, stackProfile)
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
      "server",
      "package.json"
    )
    const sdkPkg = JSON.parse(await fs.readFile(sdkPkgPath, "utf-8"))
    log("server SDK version", sdkPkg.version)
  } catch {
    log("server SDK version", "UNKNOWN (could not read server package.json)")
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
  // Normalize BOTH sides identically: realpath expands symlinks (npm .bin shims)
  // AND Windows 8.3 short names (e.g. MALIND~1). Realpath-ing only argv[1] (the
  // old behavior) made the two sides diverge on short-name profiles/temp dirs —
  // the server then exited 0 without serving, exactly the DOA class the publish
  // smoke exists to catch.
  const normalize = async (p: string): Promise<string> => {
    try {
      return path.resolve(await fs.realpath(p))
    } catch {
      return path.resolve(p)
    }
  }
  return (await normalize(process.argv[1])) === (await normalize(fileURLToPath(import.meta.url)))
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
    // serveStdio negotiates both the legacy 2025 initialize handshake and the
    // modern 2026-07-28 server/discover era, pinning one server per connection.
    const stdio = serveStdio(() => createServer({ host }), {
      onerror: (error) => console.error(`[foreman] MCP stdio error: ${error.message}`),
    })

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
        await stdio.close()
      } catch {
        /* ignore */
      }
      process.exit(0)
    }
    process.stdin.on("end", shutdown)
    process.stdin.on("close", shutdown)
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  }
}
