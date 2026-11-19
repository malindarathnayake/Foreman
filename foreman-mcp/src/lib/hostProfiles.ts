/**
 * Host profile resolution for Foreman.
 *
 * Foreman runs under different agent hosts (Claude Code, Cursor, Codex, Google
 * Antigravity). Each host
 * has its own way to spawn implementation workers and reach deliberation advisors.
 * Skill files reference these via placeholders (e.g. {{worker_invoke}}); this module
 * supplies the host-specific text those placeholders resolve to.
 *
 * The claude-code / cursor / codex / antigravity profiles are RENDERED compatibility presets over the
 * generic six-capability contract (HOST-CONTRACT.md), not privileged modes.
 *
 * Resolution precedence (caller's responsibility — see resolveHost):
 *   1. --host=<value> CLI flag
 *   2. FOREMAN_HOST environment variable
 *   3. Default: "claude-code"
 */

import {
  ANTIGRAVITY_NATIVE_REVIEW,
  ANTIGRAVITY_PROTOCOL_SECTIONS,
  ANTIGRAVITY_REVIEW_MODE,
  CODEX_NATIVE_REVIEW,
  CODEX_PROTOCOL_SECTIONS,
  CODEX_REVIEW_MODE,
} from "./codexProtocol.js"

export type HostId = "claude-code" | "cursor" | "codex" | "antigravity" | "generic"

export const KNOWN_HOSTS: ReadonlyArray<HostId> = ["claude-code", "cursor", "codex", "antigravity", "generic"]

export interface HostProfile {
  id: HostId
  displayName: string
  /** Map of placeholder name -> replacement text. Names exclude the surrounding {{...}}. */
  placeholders: Record<string, string>
  protocolSections?: Record<string, string>
  /**
   * Text prepended to every loaded skill on this host, after all other rendering.
   * Used for host facts every skill needs, such as how Foreman tool names map to
   * the host's own tool names.
   */
  skillHeader?: string
}

const SHARED_TREE_SAFETY =
  " Tier models may be configured per profile in .foreman-worker-models.json; capability_check reports the effective mapping and missing seat agents. After a rejected premium attempt, the next fresh attempt uses tier frontier on every profile unless the owner authorizes an override. Use worker_frontier on Codex or foreman-worker-frontier on Claude Code/Cursor/Antigravity; generic hosts use their configured frontier model. Record the host-confirmed worker_model and model_evidence in set_verdict; a tier with a pinned model cannot pass without matching evidence.  Repository state is user-owned: the worker may use read-only Git inspection only and must never run git stash, reset, checkout, switch, clean, add, commit, merge, rebase, cherry-pick, worktree, or any command that changes the index, stash, refs, branch, HEAD, or files outside the brief. If repository state blocks the task, stop and report it unchanged. Heartbeat: every few tool calls append one JSON line {\"ts\",\"phase\",\"unit\",\"attempt\",\"files\":[touched so far],\"note\"} to Docs/.foreman-heartbeat.jsonl (Foreman-owned, excluded from the guard); the attempt number is in the delegation result. Docs/ and the harness are the pit-boss's: never write there."

const CLAUDE_CODE_PROFILE: HostProfile = {
  id: "claude-code",
  displayName: "Claude Code",
  placeholders: {
    host_name: "Claude Code",
    worker_invoke:
      'Use the Agent tool. If `.claude/agents/foreman-worker*.md` exist (claude_agents_init writes them), spawn with `subagent_type` and NO model or effort argument, so the seat binds its own model AND reasoning effort: `foreman-worker-light` (tier cheap) when the brief names the exact edit — a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern; `foreman-worker` (tier standard) as the default for ordinary implementation and anything unclassifiable; `foreman-worker-heavy` (tier premium) for concurrency, migrations, error-handling semantics, public contracts or schemas, security/authz paths, and any unit a lower seat already failed; `foreman-worker-frontier` (tier frontier) for the attempt after a rejected premium attempt — the ledger refuses anything lower there unless the owner sets user_override. Below premium, escalate on evidence, never on a hunch: a fix worker moves up a tier only when `route_reason` cites a refined brief or an advisor diagnosis of the failure; a rejection alone is not evidence. Never start at premium or frontier to save a round. Without those definitions, or when the spawn fails with "Agent type ... not found" (definitions written this session may not load until the next one), fall back to a general-purpose agent with the model of the tier (`model: "sonnet"` for cheap and standard, `model: "opus"` for premium, `model: "fable"` for frontier), record the tier, and say "fallback: agent type not loaded" in `route_reason`. Pass only the worker brief — no spec, no ledger, no progress file.' + SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: editing Agent-tool workers share repository state and MUST run sequentially by default. Record `write_ledger` `s:'delegated'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only explorer Agents may run in parallel. Parallel EDITING workers are permitted only under ALL of: (a) each worker is spawned with `isolation: \"worktree\"`; (b) their editable file sets are disjoint — any overlap means do not parallelize; (c) each worker returns its full `git diff` output in its completion report; (d) the pitboss applies those diffs to the main tree serially, validating each unit before applying the next; (e) any apply conflict rejects that unit for sequential re-delegation; (f) line endings: run `git config --get core.autocrlf` and `git ls-files --eol -- <unit files>` before creating any worktree — if autocrlf is `true` and those files have no `.gitattributes` eol rule, do NOT parallelize, serialize on the shared tree; create worktrees with `git -c core.autocrlf=false worktree add --detach …` so the checkout matches the index; run `git apply --check` before applying a returned diff and reject one whose line endings disagree with the target path's `git ls-files --eol` attributes. The full worktree fan-out contract (base-commit guarantees, content-addressed patch artifacts, cleanup) is v0.6 HOST-CONTRACT scope — until then this manual procedure is the only sanctioned parallel-edit path. Workers must not spawn further agents.",
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "codex" })` and `mcp__foreman__capability_check({ cli: "gemini" })`',
    advisor_a:
      '**Codex:** `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })`',
    advisor_b:
      '**Gemini:** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback:
      "**Fable agent fallback (last rung):** With no council seats AND no CLI advisor, seat BOTH reviewers on Fable — two separate Agent-tool calls with `model: \"fable\"` (`model: \"opus\"` when the host cannot run Fable), each given a DIFFERENT adversarial critic prompt (e.g. one contract/correctness, one security/data-integrity), run independently and never shown each other's output. Record in the ledger note that independent review was unavailable: two seats on one model is perspective, NOT independence.",
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
      'Prefer the Cursor Agent CLI (binary `agent`, alias `cursor-agent`; the editor UI CLI is `cursor` and is not the agent). Probe with `mcp__foreman__capability_check({ cli: "cursor" })`. Spawn workers in print mode: `agent -p --force --trust --output-format text` with the brief as the prompt (or a short instruction to read a prompt file when the brief is long). Do not pass `--approve-mcps` — the child must not load Foreman MCP. Isolation: add `-w` / `--worktree`. Do not pin `--model` unless the operator supplied a verified id; inherit. If the Agent CLI is missing AND this session has the Cursor `Task` tool, fall back to Task: if `.cursor/agents/foreman-worker*.md` exist (cursor_agents_init writes them), spawn with `subagent_type` and NO model argument: `foreman-worker-light` (tier cheap) when the brief names the exact edit — a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern; `foreman-worker` (tier standard) as the default for ordinary implementation and anything unclassifiable; `foreman-worker-heavy` (tier premium) for concurrency, migrations, error-handling semantics, public contracts or schemas, security/authz paths, and any unit a lower seat already failed. Escalate on evidence, never on a hunch: a fix worker moves up a tier only when `route_reason` cites a refined brief or an advisor diagnosis of the failure; a rejection alone is not evidence. Never start at premium to save a round. Without those definitions, fall back to `subagent_type: "generalPurpose"` with no model argument (inherit the pit-boss) and still record the tier. Do not use `.claude/agents/` seats as the Cursor spawn target: those pin Claude Code aliases. Pass only the worker brief — no spec, no ledger, no progress file.' + SHARED_TREE_SAFETY,
    worker_fanout:
      'When Step 2 batches to N workers: editing workers share the parent checkout by default (Task) and MUST run sequentially unless each is launched with isolation (`agent -p --force --trust -w`, or a Task isolated worktree/copy) AND their editable file sets are disjoint. Record `write_ledger` `s:\'delegated\'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only explorer Tasks may run in parallel. Isolated editing workers return their full `git diff` in the completion report; the pitboss applies those diffs to the main tree serially, validating each unit before applying the next; an apply conflict rejects that unit for sequential re-delegation. Workers must not spawn further agents. Call `cursor_agents_init` if Task seats are missing.',
    advisor_checks:
      '`mcp__foreman__capability_check({ cli: "cursor" })`. For independence, also probe `cli: "claude"`, `cli: "codex"`, and `cli: "gemini"` — only a different vendor CLI is a second seat. Two Cursor Agent CLI calls are the same router.',
    advisor_a:
      '**Advisor A (Cursor Agent CLI):** `mcp__foreman__invoke_advisor({ cli: "cursor", prompt: "<PROMPT>" })` — Foreman runs `agent -p --mode=ask --trust --output-format text` (never `--approve-mcps`, never a pinned `--model`). Receipts are provider unknown (Cursor is a router), so one Cursor seat is `receipted`, not `receipted_external`.',
    advisor_b:
      '**Advisor B (independent vendor):** if capability_check reports ok for claude, codex, or gemini, `mcp__foreman__invoke_advisor` that CLI. A second `cli: "cursor"` call is perspective, not independence.',
    advisor_fallback:
      '**Adversarial fallback (last rung):** With no council seats AND no other-vendor CLI, seat BOTH reviewers as perspective: two separate Cursor Agent CLI ask-mode calls, or two Cursor `Task` inherit seats (`subagent_type: "generalPurpose"`, no model argument), each with a DIFFERENT adversarial critic prompt, run independently and never shown each other\'s output. Record in the ledger note that independent review was unavailable: two seats on one model is perspective, NOT independence.',
    autonomy:
      "**Background-agent surface:** a Cursor background agent may carry a Foreman goal only with budgets/scopes declared up front; evidence claims in-transcript; the goal ends at the phase gate; re-enter via `session_orient` after any context reset.",
  },
}

// Codex has its own native collaboration and advisor surfaces. Keep this profile
// explicit: inheriting Claude Code text silently reintroduces Agent-tool/Opus instructions.
const CODEX_PROFILE: HostProfile = {
  id: "codex",
  displayName: "Codex",
  protocolSections: CODEX_PROTOCOL_SECTIONS,
  placeholders: {
    host_name: "Codex",
    review_mode: CODEX_REVIEW_MODE,
    session_advisor_setup: "Native Codex mode: confirm native collaboration is available. At major checkpoints, probe optional Claude/Gemini advisors and record version/auth_status; leave unprobed entries null. Missing CLIs do not block native review.",
    cli_unavailable: "Continue native Codex review; record optional advisor unavailability in limitations. No missing-CLI waiver is needed.",
    worker_invoke:
      'Use Codex `spawn_agent` to create a disposable implementation subagent in a fresh context. Pass only the bounded worker brief — no inherited conversation, spec, ledger, or progress file. Report the returned agent ID beside the unit ID, wait using native host tools, and preserve the completion report before releasing the agent. ' +
      'PICK THE SEAT FROM THE UNIT, and record the same word as the ledger `tier`: ' +
      '`worker_light` (tier cheap) when the brief names the exact edit — a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern; ' +
      '`worker` (tier standard) for ordinary implementation where the brief states the behaviour and the seat chooses the code — this is the default, and an unclassifiable unit belongs here; ' +
      '`worker_heavy` (tier premium) for concurrency, migrations, error-handling semantics, public contracts or schemas, security/authz paths, and any unit a lower seat already failed. ' +
      'Escalate on evidence, never on a hunch: a fix worker moves up a tier only when `route_reason` cites a refined brief or an advisor diagnosis of the failure; a rejection alone is not evidence. Never start at premium to save a round. ' +
      'Model pins live in `.codex/agents/<role>.toml` (written by `codex_agents_init`), so the seat is host configuration rather than a claim in this text; record the model Codex reports and never attest one the host did not confirm. ' +
      'Reasoning effort is host-owned in this build: pass it at spawn time if your Codex exposes it — high for light and standard, xhigh for heavy — and do not assert an effort the host did not apply.' + SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: Codex `spawn_agent` workers share the repository and editing `worker` roles MUST run sequentially unless each has a proven isolated worktree/sandbox. Record `write_ledger` `s:'delegated'` before each spawn; validate its repository-state guard and verdict before the next editing worker. Read-only `explorer` roles may use `agents.max_threads` in parallel. Patch-only workers may run in parallel only for disjoint editable sets with a content-addressed apply check. Keep `agents.max_depth=1`; workers must not spawn further agents. Every editing seat in a batch is picked per unit (`worker_light` / `worker` / `worker_heavy`), not once for the batch. Call `codex_agents_init` if roles are missing.",
    advisor_checks:
      'At major checkpoints or on request, probe optional advisors: `mcp__foreman__capability_check({ cli: "claude" })` and `mcp__foreman__capability_check({ cli: "gemini" })`. Missing providers do not block native review.',
    advisor_a:
      '**Optional external Advisor A (Claude Fable 5.2, max; headless; Opus when Fable is unavailable):** `mcp__foreman__invoke_advisor({ cli: "claude", prompt: "<PROMPT>" })` (configured `model: "claude-fable-5-2"`, effort `max`, tools disabled; the output names any model_fallback).',
    advisor_b:
      '**Optional external Advisor B (Gemini):** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`',
    advisor_fallback: CODEX_NATIVE_REVIEW,
    autonomy:
      "Codex continuation is host-controlled: declare budgets and scope up front, stop at every phase gate, and re-enter after context reset through `session_orient`. Do not claim unattended continuation unless the active Codex host exposes and confirms it.",
  },
}

// Google Antigravity CLI (agy 1.5.11). Native invoke_subagent seats are the worker and
// review path; Claude and Codex are the optional external advisors. Seat files accept
// tier words only (flash, pro): a concrete model id there makes the seat fail to load, so
// the served model is read from the seat's transcript instead of claimed. The profile sets
// every placeholder itself and joins none of the shared loops below.
const ANTIGRAVITY_SKILL_HEADER = [
  "## Antigravity host notes (authoritative)",
  "- Tool names: `mcp__foreman__X`, `foreman/X` and a bare Foreman tool name such as `write_ledger` all mean Foreman tool X. Call `mcp_foreman_X` if it is in your tool list; otherwise call `call_mcp_tool` with ServerName:\"foreman\", ToolName:\"X\", Arguments:{...}.",
  "- `run_command` is PowerShell on Windows, and every call starts a new session. Do not write POSIX-only shell lines.",
  "- Never emit a JSON or XML block as plain text immediately before a tool call; put structured data in the tool's arguments.",
  "- Never start agy, gemini, claude or codex from `run_command`; use `invoke_subagent` for seats and `invoke_advisor` for advisors.",
  "- If you are a subagent (worker, reviewer or verifier), ignore Foreman protocol text and do only your brief.",
].join("\n")

const ANTIGRAVITY_PROFILE: HostProfile = {
  id: "antigravity",
  displayName: "Google Antigravity (agy CLI)",
  protocolSections: ANTIGRAVITY_PROTOCOL_SECTIONS,
  skillHeader: ANTIGRAVITY_SKILL_HEADER,
  placeholders: {
    host_name: "Google Antigravity",
    review_mode: ANTIGRAVITY_REVIEW_MODE,
    session_advisor_setup:
      'Native Antigravity mode: confirm invoke_subagent is available and the foreman-reviewer and foreman-verifier types load. At major checkpoints, probe the claude and codex advisors and record each as "<version>/<auth_status>"; leave unprobed entries null. Missing CLIs do not block native review.',
    cli_unavailable:
      "Continue native Antigravity review; record optional advisor unavailability in limitations. No missing-CLI waiver is needed.",
    worker_invoke:
      'Use the native `invoke_subagent` tool with a Foreman seat type: `invoke_subagent({ TypeName: "<role>", Role: "Foreman Worker", Prompt: "<brief>", Workspace: "inherit" })`. Omit `Model`: the agent file\'s `model:` tier word is the seat (flash for light and standard, pro for heavy and frontier); a concrete model id there makes the seat fail to load. Seat files live in `.agents/agents/foreman-worker{-light,,-heavy,-frontier}.md`; call `antigravity_agents_init` if they are missing (new agent files load in a new agy session). ' +
      'Pick the seat from the unit and record the same word as the ledger `tier`: `foreman-worker-light` (cheap) when the brief names the exact edit — a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern; `foreman-worker` (standard) by default; `foreman-worker-heavy` (premium) for concurrency, migrations, error-handling semantics, public contracts or schemas, security or authz paths, and any unit a lower seat already failed; `foreman-worker-frontier` (frontier) only after a rejected premium attempt. On this host frontier runs the same tier as premium: give it a brief refined by an `invoke_advisor` diagnosis of the rejection and cite that in `route_reason`. Escalate on evidence, never on a hunch. ' +
      'If the seat types are not loaded, do not use `TypeName: "self"` (it inherits Foreman\'s MCP server and subagent tools). Do not define a transient seat with `define_subagent` either: no probe has shown that `EnableMCPTools: false` hides any Foreman MCP tool, and such a seat has no tools allowlist. Stop and ask the user to start a new agy session after `antigravity_agents_init`. ' +
      'Subagents run in the background and message you when done: do not poll; wait for the completion message. `invoke_subagent` returns `conversationId` and `logAbsoluteUri`: report the conversationId beside the unit ID, then `read_file` the transcript at logAbsoluteUri (`.../brain/<id>/.system_generated/logs/transcript.jsonl`) and record its `"model"` value (for example `gemini-4-hydrogen-tiered-xhigh`) as `worker_model`, with the transcript path as `model_evidence`. Never record a model the transcript does not show; if it shows none, leave `worker_model` unset and say so. ' +
      'Write the brief in this order: role and hard constraints (allowed files, forbidden actions, output contract) first; spec excerpts and code in XML-tagged blocks next; then "Based on the context above," followed by the concrete task last. ' +
      "Pass only the worker brief: no spec, no ledger, no progress file. The worker seat has no Foreman tools and must not call any." +
      SHARED_TREE_SAFETY,
    worker_fanout:
      "When Step 2 batches to N workers: editing workers run sequentially with `Workspace: \"inherit\"`. Record `write_ledger` `s:'delegated'` before each spawn, and validate its repository-state guard and verdict before the next editing worker. Read-only explorers may run in parallel. Do not use `Workspace: \"branch\"` or `\"share\"` for editors (a branch copy includes your uncommitted changes, so its diff is not the worker's alone). Do not use `run_workflow`, `/swarm`, `/teamwork` or `/boost` for implementation. Workers must not spawn further agents. Call `antigravity_agents_init` if seats are missing.",
    advisor_checks:
      'At major checkpoints or on request: `mcp__foreman__capability_check({ cli: "claude" })` and `mcp__foreman__capability_check({ cli: "codex" })`. Two receipted seats from different vendors make a cross-vendor review whatever model you run. `cli: "gemini"` runs Gemini through agy: when you run a Gemini model it is the same vendor, so treat it as perspective. Missing CLIs do not block native review.',
    advisor_a:
      '**Optional external Advisor A (Claude Fable 5.2, max; headless; Opus when Fable is unavailable):** `mcp__foreman__invoke_advisor({ cli: "claude", prompt: "<PROMPT>" })` (configured `model: "claude-fable-5-2"`, effort `max`, tools disabled; the output names any model_fallback).',
    advisor_b:
      '**Optional external Advisor B (Codex, gpt-6.2-astra xhigh):** `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })` (configured `model: "gpt-6.2-astra"`).',
    advisor_fallback: ANTIGRAVITY_NATIVE_REVIEW,
    autonomy:
      "Antigravity continuation is not declared to Foreman. Declare budgets and scope up front, stop at every phase gate, and re-enter after a context reset or /compact through mcp__foreman__session_orient. /goal has no turn limit, so Foreman's attempt cap and phase gates remain the stop authority; never roll into the next phase. Implement in default or accept-edits mode: plan mode drafts an Implementation Plan artifact and stops, and approving that artifact is not a Foreman gate pass.",
    workflows: "No saved-workflow surface on this host; use the review and deliberation paths above.",
    session_compact: "/compact",
    session_clear: "/clear",
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

// Common setup remains external-first on the other hosts.
for (const profile of [CLAUDE_CODE_PROFILE, CURSOR_PROFILE, GENERIC_PROFILE]) {
  profile.placeholders.review_mode = "Use the configured external advisor/council review path for this host."
  profile.placeholders.cli_unavailable = "Ask user for explicit waiver"
  profile.placeholders.session_advisor_setup = 'For sessions with phase checkpoints, run the host advisor probes and record each as "<version>/<auth_status>" instead of null; null means not probed.'
}

// 0.6.20: saved Workflow scripts exist on Claude Code only. The Workflow tool runs many
// agents on the host's own model; the hook opts the host in through the skill text, the
// user confirms before a run, and the result is perspective (stage:'fan'), never a seat.
CLAUDE_CODE_PROFILE.placeholders.workflows =
  "The Workflow tool (multi-agent orchestration, paid and user-approved) is available on this host. Install Foreman's saved scripts once per project with `mcp__foreman__claude_workflows_init` (writes .claude/workflows/foreman-checkpoint-review.js, foreman-design-panel.js, foreman-design-gauntlet.js, foreman-triage.js). " +
  "Use them at these points only: `foreman-design-panel` for an open design question in design_partner or spec work; `foreman-checkpoint-review` as the review fan at a phase checkpoint (args { phase, files, spec_excerpt }); `foreman-design-gauntlet` when a new feature, store choice or security-sensitive mechanism must be researched, designed and attacked before spec work (deliberate its findings in the main loop, re-reading the cited lines for every CRITICAL/HIGH and DISAGREE, and let the user arbitrate before anything changes); `foreman-triage` for a batch of field reports. " +
  "Before every run, confirm with the user by AskUserQuestion naming the workflow, its phases and the agent count, unless the user already opted in this session (the `ultracode` keyword or a standing instruction). " +
  "Record a checkpoint-review result with write_ledger record_review stage:'fan', the run id in limitations; every agent runs on the host's own model, so it is perspective and never a gate seat — invoke_advisor seats on another vendor still satisfy the gate and the independence bound. " +
  "Never implement inside a workflow: units go through the unit protocol with their ledger record, guard cycle and verdict; editing workers run sequentially on the shared tree."
// 0.8.0 (2026-10-07): Codex and Cursor use shared procedures; generic stays unsupported.
for (const profile of [CURSOR_PROFILE, CODEX_PROFILE]) {
  profile.placeholders.workflows =
    "Use workflow mode:'describe' before a paid run: foreman-design-panel for open design questions, foreman-design-gauntlet for research and adversarial design, foreman-checkpoint-review for a phase review fan, and foreman-triage for field reports. " +
    "Confirm the workflow, phases and agent count with the user unless the session already opted in; then call workflow with name and args and follow its numbered procedure. " +
    "Use native read-only subagents within the procedure's batch cap and live host capacity, or run sequentially in the main session if unavailable. " +
    "Never implement or write the ledger within a workflow. Results are perspective, stage:'fan', never a gate seat; invoke_advisor receipts remain separate. The user arbitrates open decisions."
}
GENERIC_PROFILE.placeholders.workflows = "No saved-workflow surface on this host; use the review and deliberation paths above."

CLAUDE_CODE_PROFILE.placeholders.session_compact = "/compact"
CLAUDE_CODE_PROFILE.placeholders.session_clear = "/clear"
CURSOR_PROFILE.placeholders.session_compact = "/compact"
CURSOR_PROFILE.placeholders.session_clear = "/clear"
CODEX_PROFILE.placeholders.session_compact = "/compact"
CODEX_PROFILE.placeholders.session_clear = "start a new thread"
GENERIC_PROFILE.placeholders.session_compact = "compact this conversation"
GENERIC_PROFILE.placeholders.session_clear = "start a new conversation"

const PROFILES: Record<HostId, HostProfile> = {
  "claude-code": CLAUDE_CODE_PROFILE,
  cursor: CURSOR_PROFILE,
  codex: CODEX_PROFILE,
  antigravity: ANTIGRAVITY_PROFILE,
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
    "**Two actors, one tree:** while a worker window is open the pit-boss does not write Docs/ or the harness; discoveries go to write_ledger record_fact (Foreman-owned, guard-excluded) and spec amendments wait for the verdict. A validation-only re-check after a guard trip is closed with close_attempt outcome:'validation_only', which charges nothing. **Declared workflow rank:** At init_session report env.model and env.effort (unknown is valid); on a model/effort change call write_journal declare_model with both fields. Trust the self-declaration; no host authentication is required for the pitboss rank. Follow the returned workflow_permissions: Middle permits mechanical same-session worker reuse and compact follow-ups; Top additionally permits bounded fixes/test changes, focused intermediate validation and independently verified worker_delta review. Standard/unknown use normal protocol. New implementation, fixes and test edits always require workers; existing scope/ownership guards, recorded attempts, required checks and checkpoint gates remain. These rank rules supersede contrary direct-fix or unconditional fresh-worker/full-review instructions below. Rank does not change agent_class, worker/reviewer capability or cost tier, never authenticates their served model, and never enters review sufficiency: gate passes are stamped with the basis that carried them, and declared ids (verifier, worker, native agents) are compared for distinctness, not verified.",
    `**Review mode:** ${ph.review_mode}`,
    `**Workflows:** ${ph.workflows}`,
    `**Session advisor setup:** ${ph.session_advisor_setup}`,
    `**Worker:** ${ph.worker_invoke}`,
    `**Worker fan-out:** ${ph.worker_fanout}`,
    `**Advisor detection:** ${ph.advisor_checks}`,
    ph.advisor_a,
    ph.advisor_b,
    ph.advisor_fallback,
    `**Session hygiene:** Foreman cannot see the context meter or run ${ph.session_compact} / ${ph.session_clear}. Only when this session's context usage is above 80%, ask the user to run ${ph.session_compact} or start a new session, then session_orient; below that, or when the usage is not visible, never ask. Before a different job, suggest ${ph.session_clear}.`,
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
