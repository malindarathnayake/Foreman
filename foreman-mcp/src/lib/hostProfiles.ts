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
    worker_fanout:
      "When Step 2 batches to N workers: for each unit, `write_ledger` `s:'delegated'` with that unit's brief BEFORE spawning; spawn up to N Agent-tool workers (`model: \"sonnet\"`) in parallel; wait for all; validate and verdict each unit independently. Workers must not spawn further agents. An explorer-class Agent (`model: \"haiku\"`, read-only) may map code paths for Step 3 / preflight — it never produces a verdict.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
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
    worker_fanout:
      'When Step 2 batches to N workers: for each unit, `write_ledger` `s:\'delegated\'` with that unit\'s brief BEFORE spawning; spawn up to N Cursor `Task` tools (`subagent_type: "generalPurpose"`, `model: "claude-4.6-sonnet-medium-thinking"`) in parallel; wait for all; validate and verdict each unit independently. Workers must not spawn further agents. An explorer Task (`subagent_type: "explore"`, `readonly: true`) may map code paths for Step 3 / preflight — it never produces a verdict.',
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Advisor A (GPT-5.6-SOL):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gpt-5.6-sol-ultra"`. Pass the deliberation prompt as the task description.',
    advisor_b:
      '**Advisor B (Gemini 3.1 Pro):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gemini-3.1-pro"`. If `gemini-3.1-pro` is unavailable in the user\'s Cursor environment, fall back to `model: "composer-2-fast"`.',
    advisor_fallback:
      '**Sonnet adversarial fallback:** Use the Cursor `Task` tool with `subagent_type: "generalPurpose"`, `model: "claude-4.6-sonnet-medium-thinking"`, and an adversarial critic prompt.',
    autonomy:
      "**Background-agent surface:** a Cursor background agent may carry a Foreman goal only with budgets/scopes declared up front; evidence claims in-transcript; the goal ends at the phase gate; re-enter via `session_orient` after any context reset.",
  },
}

// Codex has its own native collaboration and advisor surfaces. Keep this profile
// explicit: inheriting Claude Code text silently reintroduces Agent-tool/Opus instructions.
const CODEX_PROFILE: HostProfile = {
  id: "codex",
  displayName: "Codex",
  placeholders: {
    host_name: "Codex",
    worker_invoke:
      'Use Codex `spawn_agent` to create a disposable implementation subagent. Pass only the bounded worker brief — no spec, ledger, or progress file. Prefer the host-configured `gpt-5.6-luna` worker seat when Codex exposes subagent model selection; the current spawn contract may choose the model itself, so record the actual model and never attest Luna unless the host confirms it.',
    worker_fanout:
      "When Step 2 batches to N workers: for each unit, `write_ledger` `s:'delegated'` with that unit's brief BEFORE spawning; spawn up to `agents.max_threads` (default 6) Codex `spawn_agent` workers in parallel (`worker` role for implementation); wait for all; validate and verdict each unit independently. Keep `agents.max_depth=1` — workers must not spawn further agents. An `explorer` role subagent (read-only sandbox) may map code paths for Step 3 / preflight — it never produces a verdict. Prefer `gpt-5.6-luna` for workers when the host confirms model selection; record the actual model and never attest Luna unless confirmed. Call `codex_agents_init` once per project if `.codex/agents/` roles are missing.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "claude" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Advisor A (Claude Fable 5, max; headless):** `mcp__foreman__invoke_advisor({ cli: "claude", prompt: "<PROMPT>" })` (configured `model: "claude-fable-5"`, effort `max`, tools disabled).',
    advisor_b:
      '**Advisor B (Gemini):** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback:
      "**Non-independent fallback:** Run an adversarial self-review in the Codex pitboss seat and record that independent review was unavailable.",
    autonomy:
      "Codex continuation is host-controlled: declare budgets and scope up front, stop at every phase gate, and re-enter after context reset through `session_orient`. Do not claim unattended continuation unless the active Codex host exposes and confirms it.",
  },
}

const GENERIC_PROFILE: HostProfile = {
  id: "generic",
  displayName: "Generic host (six-capability contract)",
  placeholders: {
    host_name: "Generic host",
    worker_invoke:
      "Spawn a worker at tier `{tier}` with exactly this brief; return a completion report matching the completion-report schema in HOST-CONTRACT.md. A host MAY fulfil this capability via Foreman's `invoke_worker`.",
    worker_fanout:
      "When Step 2 batches to N workers: for each unit, `write_ledger` `s:'delegated'` with that unit's brief BEFORE spawning; spawn up to N workers at the declared tier in parallel (see HOST-CONTRACT.md spawn-worker); wait for all; validate and verdict each unit independently. Workers must not spawn further agents. A read-only explorer seat may map code paths for Step 3 / preflight — it never produces a verdict.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
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
 * Runtime mappings injected ahead of legacy/project overrides. Overrides may
 * predate host profiles and contain provider-specific instructions that are no
 * longer valid (for example, telling Codex to use Claude's Agent tool).
 */
export function hostRuntimePreamble(host: HostId): string {
  const ph = getProfile(host).placeholders
  return [
    "## Active Host Runtime (authoritative)",
    "The mappings below supersede provider, model, advisor, and host-tool instructions in this override body. Protocol workflow and project-specific rules below still apply.",
    "",
    `**Worker:** ${ph.worker_invoke}`,
    `**Worker fan-out:** ${ph.worker_fanout}`,
    `**Advisor detection:** ${ph.advisor_checks}`,
    ph.advisor_a,
    ph.advisor_b,
    ph.advisor_fallback,
  ].join("\n")
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
