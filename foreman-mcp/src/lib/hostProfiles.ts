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

const SHARED_TREE_SAFETY =
  " Repository state is user-owned: the worker may use read-only Git inspection only and must never run git stash, reset, checkout, switch, clean, add, commit, merge, rebase, cherry-pick, worktree, or any command that changes the index, stash, refs, branch, HEAD, or files outside the brief. If repository state blocks the task, stop and report it unchanged."

const CLAUDE_CODE_PROFILE: HostProfile = {
  id: "claude-code",
  displayName: "Claude Code",
  placeholders: {
    host_name: "Claude Code",
    worker_invoke:
      'Use Agent tool with `model: "sonnet"`. Pass only the worker brief — no spec, no ledger, no progress file.' + SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: editing Agent-tool workers share repository state and MUST run sequentially by default. Record `write_ledger` `s:'delegated'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only explorer Agents may run in parallel. Parallel EDITING workers are permitted only under ALL of: (a) each worker is spawned with `isolation: \"worktree\"`; (b) their editable file sets are disjoint — any overlap means do not parallelize; (c) each worker returns its full `git diff` output in its completion report; (d) the pitboss applies those diffs to the main tree serially, validating each unit before applying the next; (e) any apply conflict rejects that unit for sequential re-delegation; (f) line endings: run `git config --get core.autocrlf` and `git ls-files --eol -- <unit files>` before creating any worktree — if autocrlf is `true` and those files have no `.gitattributes` eol rule, do NOT parallelize, serialize on the shared tree; create worktrees with `git -c core.autocrlf=false worktree add --detach …` so the checkout matches the index; run `git apply --check` before applying a returned diff and reject one whose line endings disagree with the target path's `git ls-files --eol` attributes. The full worktree fan-out contract (base-commit guarantees, content-addressed patch artifacts, cleanup) is v0.6 HOST-CONTRACT scope — until then this manual procedure is the only sanctioned parallel-edit path. Workers must not spawn further agents.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Codex:** `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })`',
    advisor_b:
      '**Gemini:** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback:
      "**Opus agent fallback (last rung):** With no council seats AND no CLI advisor, seat BOTH reviewers on Opus — two separate Agent-tool calls with `model: \"opus\"`, each given a DIFFERENT adversarial critic prompt (e.g. one contract/correctness, one security/data-integrity), run independently and never shown each other's output. Record in the ledger note that independent review was unavailable: two seats on one model is perspective, NOT independence.",
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
      'Use the Cursor `Task` tool with `subagent_type: "generalPurpose"` and `model: "claude-4.6-sonnet-medium-thinking"`. Pass only the worker brief in the prompt — no spec, no ledger, no progress file.' + SHARED_TREE_SAFETY,
    worker_fanout:
      'When Step 2 batches to N workers: editing Cursor `Task` workers share repository state and MUST run sequentially unless each worker has a proven isolated worktree/sandbox. Record `write_ledger` `s:\'delegated\'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only explorer Tasks may run in parallel. Patch-only workers may run in parallel only for disjoint editable sets with a content-addressed apply check. Workers must not spawn further agents.',
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Advisor A (GPT-5.6-SOL):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gpt-5.6-sol-ultra"`. Pass the deliberation prompt as the task description.',
    advisor_b:
      '**Advisor B (Gemini 3.1 Pro):** Use the Cursor `Task` tool with `subagent_type: "explore"`, `readonly: true`, `model: "gemini-3.1-pro"`. If `gemini-3.1-pro` is unavailable in the user\'s Cursor environment, fall back to `model: "composer-2-fast"`.',
    advisor_fallback:
      '**Sonnet adversarial fallback (last rung):** With no council seats AND no CLI advisor, seat BOTH reviewers via two separate Cursor `Task` calls (`subagent_type: "generalPurpose"`, `model: "claude-4.6-sonnet-medium-thinking"`), each with a DIFFERENT adversarial critic prompt, run independently and never shown each other\'s output. Record in the ledger note that independent review was unavailable: two seats on one model is perspective, NOT independence.',
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
      'Use Codex `spawn_agent` to create a disposable implementation subagent. Pass only the bounded worker brief — no spec, ledger, or progress file. ' +
      'PICK THE SEAT FROM THE UNIT, and record the same word as the ledger `tier`: ' +
      '`worker_light` (tier cheap) when the brief names the exact edit — a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern; ' +
      '`worker` (tier standard) for ordinary implementation where the brief states the behaviour and the seat chooses the code — this is the default, and an unclassifiable unit belongs here; ' +
      '`worker_heavy` (tier premium) for concurrency, migrations, error-handling semantics, public contracts or schemas, security/authz paths, and any unit a lower seat already failed. ' +
      'Escalate on evidence, never on a hunch: a fix worker moves up a tier only when `route_reason` cites the rejection, a refined brief, or an advisor diagnosis. Never start at premium to save a round. ' +
      'Model pins live in `.codex/agents/<role>.toml` (written by `codex_agents_init`), so the seat is host configuration rather than a claim in this text; record the model Codex reports and never attest one the host did not confirm. ' +
      'Reasoning effort is host-owned in this build: pass it at spawn time if your Codex exposes it — high for light and standard, xhigh for heavy — and do not assert an effort the host did not apply.' + SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: Codex `spawn_agent` workers share the repository and editing `worker` roles MUST run sequentially unless each has a proven isolated worktree/sandbox. Record `write_ledger` `s:'delegated'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only `explorer` roles may use `agents.max_threads` in parallel. Patch-only workers may run in parallel only for disjoint editable sets with a content-addressed apply check. Keep `agents.max_depth=1`; workers must not spawn further agents. Every editing seat in a batch is picked per unit (`worker_light` / `worker` / `worker_heavy`), not once for the batch. Call `codex_agents_init` if roles are missing.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "claude" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Advisor A (Claude Fable 5, max; headless):** `mcp__foreman__invoke_advisor({ cli: "claude", prompt: "<PROMPT>" })` (configured `model: "claude-fable-5"`, effort `max`, tools disabled).',
    advisor_b:
      '**Advisor B (Gemini):** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback:
      "**Review fan (last rung):** With no council seats AND no CLI advisor, run the fan on Codex's own subagents instead of a self-review pass. Call `codex_agents_init` once so `reviewer` and `verifier` exist. " +
      "(1) FAN: `spawn_agent` one `reviewer` per risk lens — pick 3-5 lenses from the catalog that match the change (contract, architecture, state, security, data, tests, operability); they are read-only, run in parallel under `agents.max_threads`, and each gets ONLY its lens question plus the changed files and the spec excerpt it needs. Never give a reviewer another reviewer's output. " +
      "(2) VERIFY: `spawn_agent` one `verifier`, hand it every finding the fan returned, and require it to open each cited file:line, classify `confirmed`/`rejected`/`unverified`, re-rate severity by blast radius, merge duplicates, and return ONE report. Expect it to reject a large share — an adversarial fan on one model inflates. " +
      "(3) RECORD: `mcp__foreman__write_ledger record_review` with `stage: 'fan'`, the verifier's findings, its `checked` list, and `limitations` naming which advisor CLIs were unavailable and why. " +
      "A fan is PERSPECTIVE, not independence: separate contexts and one lens each, but one model, so its blind spots are correlated. The ledger records it and the phase gate does NOT count it as a seat. When the fan is your only review, present its report to the user and get an explicit decision before `update_phase_gate` — the same arbitration the unavailable/unavailable row already requires, now with real evidence attached. Keep `max_depth=1`: reviewers and the verifier never spawn further agents.",
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
      "Spawn a worker at tier `{tier}` with exactly this brief; return a completion report matching the completion-report schema in HOST-CONTRACT.md. A host MAY fulfil this capability via Foreman's `invoke_worker`." + SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: editing workers MUST run sequentially unless the host guarantees an isolated worktree/sandbox per worker. Record `write_ledger` `s:'delegated'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only explorers may run in parallel. Patch-only workers may run in parallel only for disjoint editable sets with a content-addressed apply check. Workers must not spawn further agents.",
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
