/**
 * Host profile resolution for Foreman.
 *
 * Foreman runs under different agent hosts (Claude Code, Cursor, Codex). Each host
 * has its own way to spawn implementation workers and reach deliberation advisors.
 * Skill files reference these via placeholders (e.g. {{worker_invoke}}); this module
 * supplies the host-specific text those placeholders resolve to.
 *
 * The claude-code / cursor / codex profiles are RENDERED compatibility presets over the
 * generic six-capability contract (HOST-CONTRACT.md), not privileged modes.
 *
 * Resolution precedence (caller's responsibility — see resolveHost):
 *   1. --host=<value> CLI flag
 *   2. FOREMAN_HOST environment variable
 *   3. Default: "claude-code"
 */

export type HostId = "claude-code" | "cursor" | "codex" | "generic"

export const KNOWN_HOSTS: ReadonlyArray<HostId> = ["claude-code", "cursor", "codex", "generic"]

export interface HostProfile {
  id: HostId
  displayName: string
  /** Map of placeholder name -> replacement text. Names exclude the surrounding {{...}}. */
  placeholders: Record<string, string>
}

const CLAUDE_CODE_PROFILE: HostProfile = {
  id: "claude-code",
  displayName: "Claude Code",
  placeholders: {
    host_name: "Claude Code",
    worker_invoke:
      'Use Agent tool with `model: "sonnet"`. Pass only the worker brief — no spec, no ledger, no progress file.',
    advisor_a:
      '**Codex:** `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })`',
    advisor_b:
      '**Gemini:** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback:
      "**Opus agent fallback:** Use Agent tool with `model: \"opus\"` and adversarial critic prompt.",
    autonomy:
      "**/goal contract:** run autonomously only under a user-issued goal with budgets/scopes declared up front; every claim in the goal report must be evidenced in-transcript (file:line, command output); the goal ends at the phase gate — never roll into the next phase autonomously.",
  },
}

const CURSOR_PROFILE: HostProfile = {
  id: "cursor",
  displayName: "Cursor",
  placeholders: {
    host_name: "Cursor",
    worker_invoke:
      'Use the Cursor `Task` tool with `subagent_type: "generalPurpose"` and `model: "claude-4.6-sonnet-medium-thinking"`. Pass only the worker brief in the prompt — no spec, no ledger, no progress file.',
    advisor_a:
      '**Advisor A (GPT-5.5):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gpt-5.5-high"`. Pass the deliberation prompt as the task description.',
    advisor_b:
      '**Advisor B (Gemini 3.1 Pro):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gemini-3.1-pro"`. If `gemini-3.1-pro` is unavailable in the user\'s Cursor environment, fall back to `model: "composer-2-fast"`.',
    advisor_fallback:
      '**Sonnet adversarial fallback:** Use the Cursor `Task` tool with `subagent_type: "generalPurpose"`, `model: "claude-4.6-sonnet-medium-thinking"`, and an adversarial critic prompt.',
    autonomy:
      "**Background-agent surface:** a Cursor background agent may carry a Foreman goal only with budgets/scopes declared up front; evidence claims in-transcript; the goal ends at the phase gate; re-enter via `session_orient` after any context reset.",
  },
}

// codex host is currently an alias for claude-code (placeholder for future codex-as-host work)
const CODEX_PROFILE: HostProfile = {
  ...CLAUDE_CODE_PROFILE,
  id: "codex",
  displayName: "Codex CLI (alias of Claude Code)",
  placeholders: {
    ...CLAUDE_CODE_PROFILE.placeholders,
    autonomy:
      "DRAFT — codex-as-host autonomy is unspecified in v0.5.0; refine with Codex directly before relying on it.",
  },
}

const GENERIC_PROFILE: HostProfile = {
  id: "generic",
  displayName: "Generic host (six-capability contract)",
  placeholders: {
    host_name: "Generic host",
    worker_invoke:
      "Spawn a worker at tier `{tier}` with exactly this brief; return a completion report matching the completion-report schema in HOST-CONTRACT.md. A host MAY fulfil this capability via Foreman's `invoke_worker`.",
    advisor_a:
      "**Advisor A:** invoke the host's first configured independent advisor seat with the deliberation prompt verbatim; return the advisor's full review text.",
    advisor_b:
      "**Advisor B:** invoke the host's second configured independent advisor seat with the deliberation prompt verbatim; return the advisor's full review text.",
    advisor_fallback:
      "**Adversarial self-review fallback:** if no independent advisor seat is available, run an adversarial self-review at the strongest available tier with an adversarial critic prompt, and record in the ledger note that independent review was unavailable.",
    autonomy:
      "Autonomy is a declared capability — see HOST-CONTRACT.md: the host declares budgets and scopes up front; absence of a declaration fails closed (no autonomous continuation); suspend across compaction and re-enter via `session_orient`; Foreman ships the continuation directive, the host supplies the trigger.",
  },
}

const PROFILES: Record<HostId, HostProfile> = {
  "claude-code": CLAUDE_CODE_PROFILE,
  cursor: CURSOR_PROFILE,
  codex: CODEX_PROFILE,
  generic: GENERIC_PROFILE,
}

/**
 * Resolve the active host id from caller-provided flag and env values.
 *
 * Unknown values fall back to "claude-code" with a stderr warning. Returning
 * the default rather than throwing keeps existing workflows running even when a
 * user typos the flag — fail-open is appropriate because the worst case is the
 * pre-existing behavior.
 */
export function resolveHost(opts: { flag?: string | null; env?: string | null }): HostId {
  const flag = opts.flag?.trim()
  const env = opts.env?.trim()

  const candidate = flag || env
  if (!candidate) return "claude-code"

  if ((KNOWN_HOSTS as ReadonlyArray<string>).includes(candidate)) {
    return candidate as HostId
  }

  console.error(
    `[foreman] Unknown FOREMAN_HOST value "${candidate}" — falling back to "claude-code". ` +
      `Accepted values: ${KNOWN_HOSTS.join(", ")}.`
  )
  return "claude-code"
}

export function getProfile(host: HostId): HostProfile {
  return PROFILES[host]
}

/**
 * Parse a `--host=<value>` flag from a process.argv-style array.
 * Returns null if no flag is present. Accepts both `--host=cursor` and `--host cursor`.
 */
export function parseHostFlag(argv: ReadonlyArray<string>): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--host=")) {
      return a.slice("--host=".length)
    }
    if (a === "--host" && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return null
}
