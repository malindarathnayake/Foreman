import { runExternalCli, resolveFirst, type SpawnPlan } from "../lib/externalCli.js"
import { toKeyValue } from "../lib/toon.js"
import { type HostId } from "../lib/hostProfiles.js"
import { CURSOR_AGENT_BINS, type AdvisorCli } from "../lib/advisorCli.js"
import { GEMINI_ADVISOR_MODEL, parseGeminiJson } from "./invokeAdvisor.js"

// Module-level cache for resolved SpawnPlans
const resolvedPlans = new Map<string, SpawnPlan>()

const HEALTH_COMMANDS: Record<AdvisorCli, { binaries: readonly string[]; args: string[] }> = {
  claude: {
    binaries: ["claude"],
    args: ["auth", "status"],
  },
  codex: {
    // `codex login status` is a fast, no-API-call auth probe: exit 0 = authenticated,
    // non-zero = expired/logged out. A full `codex exec` health call is slow, model-
    // dependent (a stale `-m` id alone makes it fail), and times out under the 15s
    // budget — all of which surface as a false `auth_status: expired`.
    binaries: ["codex"],
    args: ["login", "status"],
  },
  gemini: {
    binaries: ["gemini"],
    // Same model as the review seat, and JSON output so the probe can read which model
    // actually served the request (0.6.7): an accepted id is no proof of the model.
    args: ["-p", "echo health check", "-m", GEMINI_ADVISOR_MODEL, "--approval-mode", "plan", "--output-format", "json"],
  },
  cursor: {
    binaries: CURSOR_AGENT_BINS,
    // Live probe of `agent status --format json` (observed 2026.09.15-d2fe57e):
    // { status, isAuthenticated, hasAccessToken, hasRefreshToken, userInfo }.
    // Do not use `agent mcp list` — that command can hang waiting on MCP approval.
    args: ["status", "--format", "json"],
  },
}

export type AuthStatus = "ok" | "not_found" | "not_trusted" | "auth_expired" | "probe_timeout" | "model_substituted" | "error"

interface SentinelRow {
  cli: AdvisorCli
  /** CLI version the sentinel was observed against. Re-verify rows on every CLI version bump. */
  cli_version_pin: string
  kind: "exit_code" | "stderr_substring"
  /** exit code number, "any_nonzero" wildcard, or stderr substring */
  value: number | "any_nonzero" | string
  maps_to: AuthStatus
  provenance: string
}

/**
 * Versioned per-CLI sentinel table (D11) — the recorded exemption to the
 * no-prose-classification rule: entries are bounded, version-pinned sentinels,
 * NOT unbounded regex corpora. Specific rows are checked before wildcards.
 * Rule: re-verify this table on every CLI version bump.
 */
export const SENTINEL_TABLE: readonly SentinelRow[] = [
  {
    cli: "gemini", cli_version_pin: "0.47.0", kind: "exit_code", value: 55, maps_to: "not_trusted",
    provenance: "Session-observed 2026-07-06 against gemini 0.47.0: exit 55 = folder-trust refusal. Version pin re-verified live at implementation (gemini --version -> 0.47.0).",
  },
  {
    cli: "gemini", cli_version_pin: "0.47.0", kind: "exit_code", value: 52, maps_to: "error",
    provenance: "Session-observed 2026-07-06 against gemini 0.47.0: exit 52 = config error (not an auth state). Version pin re-verified live at implementation.",
  },
  {
    cli: "codex", cli_version_pin: "0.142.4", kind: "exit_code", value: "any_nonzero", maps_to: "auth_expired",
    provenance: "Documented probe semantics of `codex login status`: exit 0 = authenticated, non-zero = expired/logged out. Re-verified live 2026-07-06 against codex-cli 0.142.4 (exit 0 while authenticated).",
  },
]

function hintFor(status: AuthStatus, cli: AdvisorCli): string | null {
  switch (status) {
    case "ok": return null
    case "not_found":
      return cli === "cursor"
        ? "install the Cursor Agent CLI (agent / cursor-agent) or fix PATH, then re-run capability_check"
        : "install the CLI or fix PATH, then re-run capability_check"
    case "probe_timeout": return "probe exceeded its 15s budget — retry; if persistent, check login state and network"
    case "not_trusted": return "trust the folder: run the gemini CLI interactively in this directory once and accept the trust prompt"
    case "auth_expired": {
      if (cli === "claude") return "re-login: run `claude auth login`"
      if (cli === "codex") return "re-login: run `codex login`"
      if (cli === "cursor") return "re-login: run `agent login`"
      return "re-authenticate: run the gemini CLI interactively (or fix GEMINI_API_KEY)"
    }
    case "model_substituted":
      return "the CLI answered with a different model than the pinned one, so the seat cannot run on the pinned model on this account or CLI version — pin a model the CLI serves, or update the CLI or account"
    case "error": return "unclassified CLI error — run the health command manually and inspect stderr"
  }
}

function classifyNonZeroExit(cli: AdvisorCli, exitCode: number, stderr: string): AuthStatus {
  // `claude auth status` is itself the stable auth contract. Its version is
  // reported as telemetry, but review availability must not be pinned to the
  // locally observed CLI version.
  if (cli === "claude") return "auth_expired"

  const rows = SENTINEL_TABLE.filter((r) => r.cli === cli)
  // specific exit codes first
  for (const r of rows) if (r.kind === "exit_code" && r.value === exitCode) return r.maps_to
  for (const r of rows) if (r.kind === "stderr_substring" && typeof r.value === "string" && stderr.includes(r.value)) return r.maps_to
  for (const r of rows) if (r.kind === "exit_code" && r.value === "any_nonzero") return r.maps_to
  return "error"
}

function respond(
  cli: AdvisorCli,
  available: boolean,
  version: string,
  status: AuthStatus,
  extra: Record<string, string> = {}
): string {
  const hint = hintFor(status, cli)
  return toKeyValue({
    cli,
    available: String(available),
    version,
    auth_status: status,
    // 0.6.35 (field report 2026-09-25): codex login status said ok while every request got a
    // 401. The probe reads local login state only; say so rather than imply the service agrees.
    ...(status === "ok" ? { auth_scope: "local login state; the service can still reject the credential (invoke_advisor then reports failure_reason: auth_failed)" } : {}),
    ...extra,
    ...(hint ? { hint } : {}),
  })
}

/**
 * `agent status --format json` (Cursor Agent CLI 2026.09.15-d2fe57e) carries
 * isAuthenticated as a boolean. userInfo is PII and must not be copied into output.
 */
export function parseCursorAuthStatus(stdout: string): { isAuthenticated?: boolean } {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{")) return {}
  try {
    const doc: unknown = JSON.parse(trimmed)
    if (typeof doc !== "object" || doc === null) return {}
    const auth = (doc as { isAuthenticated?: unknown }).isAuthenticated
    if (typeof auth === "boolean") return { isAuthenticated: auth }
    return {}
  } catch {
    return {}
  }
}

export async function capabilityCheck(
  cli: AdvisorCli,
  _host: HostId = "claude-code"
): Promise<string> {
  const config = HEALTH_COMMANDS[cli]
  if (!config) {
    return respond(cli, false, "null", "not_found")
  }

  let plan: SpawnPlan
  if (resolvedPlans.has(cli)) {
    plan = resolvedPlans.get(cli)!
  } else {
    const resolution = await resolveFirst(config.binaries)
    if (!resolution.ok) {
      return respond(cli, false, "null", "not_found")
    }
    plan = resolution.plan
    resolvedPlans.set(cli, plan)
  }

  const cursorExtra: Record<string, string> | undefined =
    cli === "cursor" ? { mechanism: "cursor_agent_cli" } : undefined

  // First check version
  let version: string | null = null
  try {
    const vResult = await runExternalCli(plan.command, [...plan.args, "--version"], 5000)
    if (vResult.exitCode === 0) {
      version = vResult.stdout.trim().split(/\r?\n/)[0] ?? null
    }
  } catch {
    // Version check failed — CLI probably not available
  }

  // Health check
  const result = await runExternalCli(plan.command, [...plan.args, ...config.args], 15000)

  if (result.exitCode === -1 && !result.timedOut) {
    return respond(cli, false, "null", "not_found")
  }

  if (result.timedOut) {
    return respond(cli, true, version ?? "unknown", "probe_timeout", cursorExtra)
  }

  if (result.exitCode !== 0) {
    return respond(cli, true, version ?? "unknown", classifyNonZeroExit(cli, result.exitCode, result.stderr ?? ""), cursorExtra)
  }

  // 0.6.32: Cursor Agent CLI — exit 0 is not enough; isAuthenticated is the auth contract.
  if (cli === "cursor") {
    const auth = parseCursorAuthStatus(result.stdout ?? "")
    if (auth.isAuthenticated === true) {
      return respond(cli, true, version ?? "unknown", "ok", cursorExtra)
    }
    if (auth.isAuthenticated === false) {
      return respond(cli, true, version ?? "unknown", "auth_expired", cursorExtra)
    }
    return respond(cli, true, version ?? "unknown", "error", cursorExtra)
  }

  // 0.6.7: for gemini, exit 0 is not enough — the run stats say which model served the
  // request, and a pinned-but-unserved id falls through to another model silently.
  if (cli === "gemini") {
    const run = parseGeminiJson(result.stdout ?? "")
    const served = run?.mainModel
    const fields = { model_requested: GEMINI_ADVISOR_MODEL, model_served: served ?? "unknown" }
    if (served !== undefined && served !== GEMINI_ADVISOR_MODEL) {
      return respond(cli, true, version ?? "unknown", "model_substituted", fields)
    }
    return respond(cli, true, version ?? "unknown", "ok", fields)
  }

  return respond(cli, true, version ?? "unknown", "ok")
}
