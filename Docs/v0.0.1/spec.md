# Foreman MCP - Architecture Remediation Spec

## Intent

Implement the 7 required changes identified by the Architecture Council review of the Foreman MCP design (`Docs/foreman/design-summary.md`). These changes harden the design against concurrency corruption, runtime instability, state split-brain, and DX gaps before implementation begins.

## Scope

This spec covers **amendments only** — the 7 remediation items. It does not cover the full Foreman MCP implementation (planner workflow, implementor workflow, debate protocol, etc.). Those are governed by the design summary. This spec exists to ensure the foundational safety properties are in place before building on top of them.

## Decisions & Notes

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-02 | Ledger format is compact JSON (`.foreman-ledger.json`) | Ledger is for LLM consumption, not human reading. JSON is the most token-efficient structured format — no repeated key prefixes, no whitespace indentation overhead. Use `JSON.stringify(data)` (no pretty-print) for minimum token cost. |
| 2026-04-02 | `update_bundle` removed as MCP tool, replaced with CLI command | Mid-session server restart kills stdio transport. Reconnection logic exists (`client.ts:1224-1397`) but cannot survive process death. |
| 2026-04-02 | Ledger writes serialized through MCP server, not filesystem locks | MCP tool calls are sequential per-server. Server-side queue is simpler than distributed file locking across subagents. |
| 2026-04-02 | External CLI timeout set to 120s with stdin=/dev/null | Matches existing Bash tool default timeout. Prevents auth prompts from blocking indefinitely. |
| 2026-04-02 | PROGRESS.md truncation: last 10 units + summary header | Keeps context injection under ~200 lines. MCP helper returns truncated view; full file remains on disk. |
| 2026-04-02 | Ledger is THE workflow authority; host plan/task state is ephemeral | Codex found split-brain risk: `~/.claude/plans` and `~/.claude/tasks` can disagree with repo-side ledger on resume. Ledger wins. On resume, skill rebuilds host state from ledger. |
| 2026-04-02 | Implementor skill must run via SkillTool only, not slash-command | Codex found execution path divergence: slash-command loads into main thread with `command_permissions` that don't survive compaction. SkillTool runs in forked agent — correct context for multi-turn implementation. |

---

## Architecture

```text
Foreman MCP Server (Node.js, stdio transport)
│
├── Skills (delivered via skill:// resources)
│   ├── foreman:project-planner
│   └── foreman:implementor
│
├── MCP Tools (mcp__foreman__*)
│   ├── bundle_status          ← version check, read-only
│   ├── changelog              ← upgrade notes, read-only
│   ├── write_ledger           ← SERIALIZED ledger mutations
│   ├── read_ledger            ← ledger queries
│   ├── read_progress          ← TRUNCATED progress view
│   ├── write_progress         ← progress updates (append/replace)
│   ├── capability_check       ← external CLI detection
│   └── normalize_review       ← review result ingestion
│
├── NOT an MCP tool (removed):
│   └── update_bundle          ← now a CLI command
│
└── Ledger file: Docs/.foreman-ledger.json (compact JSON — token-optimized)
```

### Key Invariants

1. **No subagent writes directly to the ledger.** All ledger mutations go through `mcp__foreman__write_ledger`. The MCP server serializes calls.
2. **No mid-session self-update.** Bundle updates happen via a user-initiated CLI command outside the MCP session.
3. **External CLI calls have bounded lifetime.** Timeout + stdin redirect prevent hangs.
4. **PROGRESS.md is never injected raw.** The MCP helper returns a truncated view. Full file stays on disk for human reference.
5. **Local skills always override MCP skills.** Users can create a local `SKILL.md` with the same name to customize behavior. `uniqBy([...localCommands, ...mcpSkills], 'name')` ensures local wins.

---

## Config Schema

```json
{
  "foreman": {
    "use_external_reviewers": true,
    "external_reviewers": ["codex", "gemini"],
    "external_reviewer_timeout_ms": 120000,
    "default_worker_model": null,
    "default_planner_model": null,
    "ledger_path": "Docs/.foreman-ledger.json",
    "docs_dir": "Docs",
    "progress_truncation_units": 10,
    "mcp_transport": "stdio"
  }
}
```

---

## Change 1: Remove `update_bundle` as MCP Tool

### Problem

Calling `mcp__foreman__update_bundle` during a session would restart the MCP server process, severing the stdio transport. The MCP client reconnection logic (`src/services/mcp/client.ts:1224-1397`) handles transport hiccups but cannot survive a full process restart with new code.

### Solution

- Remove `update_bundle` from the MCP tool surface entirely.
- Replace with a user-facing CLI command (e.g., `foreman update`) that runs outside any active session.
- Keep `mcp__foreman__bundle_status` as a read-only MCP tool — it checks version compatibility and tells the LLM whether an update is recommended.
- Keep `mcp__foreman__changelog` as a read-only MCP tool.

### Startup Version Check Flow (unchanged from design, minus update)

1. Skill reads its `version` from MCP skill command metadata.
2. Calls `mcp__foreman__bundle_status`.
3. If versions match → proceed.
4. If stale but compatible → warn user, suggest running `foreman update` outside session.
5. If stale and incompatible → stop, require user to run `foreman update` and start a new session.

### Implementation Directives

- `mcp__foreman__bundle_status` tool:
  - Input: none
  - Output: `{ bundle_version, skill_versions: Record<string, string>, compatible: boolean, update_available: boolean }`
  - Format: TOON key/value (per design serialization policy)
- `mcp__foreman__changelog` tool:
  - Input: `{ since_version?: string }`
  - Output: TOON table of version/date/description entries
- CLI update command: shell script or npm update wrapper, NOT exposed to the LLM.

### Error Handling

| Scenario | Action |
|----------|--------|
| `bundle_status` returns `compatible: false` | Skill refuses to proceed. Tells user to run `foreman update`. |
| `bundle_status` returns `update_available: true, compatible: true` | Skill proceeds normally. Appends one-line notice to user. |
| `bundle_status` call fails (MCP error) | Skill proceeds with warning. Logs degraded status. |

---

## Change 2: Serialized Ledger Writes via MCP

### Problem

In-process teammates get `['*']` (all tools) by default (`src/utils/swarm/inProcessRunner.ts:995`). If subagents write to `.foreman-ledger.json` via `FileWriteTool` concurrently, the last write wins and intermediate state is lost. The swarm `permissionSync.ts` uses `proper-lockfile` for its own files, but team helpers (`teamHelpers.ts`) do NOT lock — demonstrating this is a known gap.

### Solution

All ledger mutations go through `mcp__foreman__write_ledger`. The MCP server serializes these calls internally using a simple async mutex (no filesystem locking needed — the server is a single process).

### `mcp__foreman__write_ledger` Tool

- **Input schema:**
  ```json
  {
    "operation": "set_verdict | add_rejection | update_phase_gate | set_unit_status",
    "unit_id": "string (optional, for unit-scoped ops)",
    "phase": "string (optional, for phase-scoped ops)",
    "data": "object (operation-specific payload)"
  }
  ```
- **Serialization:** Server maintains an async queue. Each `write_ledger` call acquires a mutex before read-modify-write. Use a simple promise-chain mutex (no external dependency):
  ```typescript
  let ledgerLock = Promise.resolve()
  function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = ledgerLock
    let resolve: () => void
    ledgerLock = new Promise(r => { resolve = r })
    return prev.then(fn).finally(() => resolve())
  }
  ```
- **Write pattern:** `readFile` → `JSON.parse` → mutate → `JSON.stringify` → `writeFile` (atomic via `writeFileSync` or `rename` pattern).
- **Output:** TOON key/value confirmation with operation ID and resulting state.

### `mcp__foreman__read_ledger` Tool

- **Input:** `{ unit_id?: string, phase?: string, query?: "verdicts" | "rejections" | "phase_gates" | "full" }`
- **Output:** TOON table (for lists) or key/value (for single unit). Defaults to `"full"` if no filter.

### Ledger Schema

Stored as compact JSON (single line, no pretty-print) for minimum token cost.

```json
{"v":1,"ts":"2026-04-02T12:30:00Z","phases":{"p1":{"s":"ip","g":"pending","units":{"u1a":{"s":"done","v":"pass","w":"abc123","rej":[{"r":"gemini","msg":"Missing error handling","ts":"2026-04-02T11:15:00Z"}]}}}}}
```

Expanded schema (for documentation — NOT how it's stored):
- `v` — schema version (number)
- `ts` — last updated (ISO8601)
- `phases.<id>.s` — status: `ip` (in_progress), `done` (complete), `blocked`
- `phases.<id>.g` — gate verdict: `pass`, `fail`, `pending`
- `phases.<id>.units.<id>.s` — unit status: `pending`, `ip`, `done`, `fail`
- `phases.<id>.units.<id>.v` — verdict: `pass`, `fail`, `pending`
- `phases.<id>.units.<id>.w` — worker agent ID (string | null)
- `phases.<id>.units.<id>.rej[]` — rejection history: `{r, msg, ts}`
```

### Foreman Skill Prompt Directive

The planner and implementor skill bodies MUST include:

```
CRITICAL: Never write to Docs/.foreman-ledger.json using FileWriteTool or Edit.
All ledger mutations MUST go through mcp__foreman__write_ledger.
Direct file writes to the ledger will be rejected by the Foreman review gate.
```

### Error Handling

| Scenario | Action |
|----------|--------|
| Ledger file missing | `write_ledger` creates it with `version: 1` and empty phases. |
| Ledger JSON parse error | Rename corrupt file to `.foreman-ledger.json.corrupt.{timestamp}`, create fresh. Log warning. |
| Concurrent `write_ledger` calls | Serialized by mutex. Second caller waits, no data loss. |
| Disk write failure | Return MCP error with detail. Caller retries or escalates. |

---

## Change 3: External CLI Reviewer Timeouts

### Problem

External CLI reviewers (Codex, Gemini) can hang indefinitely on auth prompts, rate limits, or interactive stdin reads. The design mentions fallback behavior but not timeout/non-interactive enforcement.

### Solution

All external CLI invocations use:
1. **Timeout:** Configurable, default 120000ms (2 minutes).
2. **Stdin redirect:** `</dev/null` to prevent interactive prompts.
3. **Non-interactive flags** where available.

### `mcp__foreman__capability_check` Tool

Before invoking external reviewers, the workflow calls:

- **Input:** `{ cli: "codex" | "gemini" }`
- **Output:** `{ available: boolean, version: string | null, auth_status: "ok" | "expired" | "unknown" }`

Auth check:
- **Codex:** Run `codex exec --skip-git-repo-check -s read-only -m gpt-5.4 "echo health check" </dev/null` with 15s timeout.
- **Gemini:** Run `gemini -p "echo health check" -m arch-review --approval-mode plan --output-format text </dev/null` with 15s timeout.

If the health check fails or times out, mark `auth_status: "expired"` and fall back to in-process agents.

### External CLI Invocation Pattern

```typescript
import { spawn } from 'child_process'

function runExternalReviewer(
  command: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })

    // Close stdin immediately to prevent interactive prompts
    child.stdin.end()

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ stdout, timedOut: true, exitCode: -1 })
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, timedOut: false, exitCode: code ?? 1 })
    })
  })
}
```

### Invocation Commands

| CLI | Command | Non-interactive |
|-----|---------|-----------------|
| Codex | `codex exec --skip-git-repo-check -s read-only -m gpt-5.4 -c reasoning.effort="high" -c hide_agent_reasoning=true` | stdin piped+closed |
| Gemini | `gemini -p "<prompt>" -m arch-review --approval-mode plan --output-format text` | `-p` flag is headless; stdin piped+closed |

### Error Handling

| Scenario | Action |
|----------|--------|
| CLI not found (`ENOENT`) | `capability_check` returns `available: false`. Workflow falls back to in-process agents. |
| Health check timeout (15s) | `auth_status: "expired"`. Workflow falls back. Reports "Codex/Gemini auth may be expired." |
| Review call timeout (120s) | Kill process. Return partial output if any. Log timeout. Workflow falls back to in-process review for that unit. |
| Non-zero exit code | Capture stderr. If output is substantive, use it. If empty/error-only, fall back. |

---

## Change 4: PROGRESS.md Truncation Strategy

### Problem

On a multi-day project, `Docs/PROGRESS.md` grows unboundedly. Injecting it raw into context wastes tokens and degrades LLM reasoning. The design says "read PROGRESS.md on resume" but doesn't specify bounded reading.

### Solution

The MCP helper `mcp__foreman__read_progress` returns a **truncated view** — summary header + last N completed units + all incomplete units. The full file remains on disk for human reference.

### `mcp__foreman__read_progress` Tool

- **Input:** `{ last_n_completed?: number }` (default: 10)
- **Output:** Structured truncated view:

```
STATUS
  phase: 3 - Integration
  last_completed: unit-2c (Core Logic / Review normalization)
  next_up: unit-3a (Integration / Codex adapter)
  blocked: none
  completed: 14/22 units across 2 phases

RECENT (last 10 completed)
  unit | phase | status | notes
  unit-2c | Core Logic | complete | Review normalization working
  unit-2b | Core Logic | complete | Ledger CRUD tested
  ...

INCOMPLETE
  unit | phase | status | notes
  unit-3a | Integration | pending | Codex adapter
  unit-3b | Integration | pending | Gemini adapter
  ...

ERRORS (if any)
  date | unit | what_failed | next_approach
  ...
```

### `mcp__foreman__write_progress` Tool

- **Input:** `{ operation: "update_status" | "complete_unit" | "log_error" | "start_phase", data: object }`
- **Output:** Confirmation with updated status summary.
- **Serialization:** Same mutex pattern as ledger writes (single process).

### Full-File Access

The raw `Docs/PROGRESS.md` is always available via `FileReadTool` for human inspection. The MCP helper is for LLM context injection only.

### Truncation Algorithm

```typescript
function truncateProgress(
  progress: ProgressFile,
  lastNCompleted: number = 10,
): TruncatedView {
  const allUnits = Object.values(progress.phases)
    .flatMap(p => Object.entries(p.units).map(([id, u]) => ({ id, phase: p.name, ...u })))

  const completed = allUnits
    .filter(u => u.status === 'complete')
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
    .slice(0, lastNCompleted)

  const incomplete = allUnits.filter(u => u.status !== 'complete')

  const errors = progress.error_log.slice(-5) // last 5 errors

  return { status: computeStatus(progress), completed, incomplete, errors }
}
```

---

## Change 5: Document Local Skill Override Mechanism

### Problem

The design moves workflow prompts into the MCP bundle, which could be perceived as a "black box." Users need to know they can override any MCP-delivered skill locally.

### Solution

Document the existing override mechanism and make it explicit in the Foreman MCP's own output.

### How It Works (Already Implemented in Claude Code)

1. `src/tools/SkillTool/SkillTool.ts:92` — `uniqBy([...localCommands, ...mcpSkills], 'name')` — local commands appear first, so `uniqBy` keeps local and drops MCP duplicates.
2. User creates `.claude/skills/foreman-implementor/SKILL.md` with the same command name.
3. The local version takes precedence. The MCP version is invisible.

### Required Documentation Points

**In `mcp__foreman__bundle_status` output, add:**
```
OVERRIDE INFO
  To customize any Foreman skill, create a local SKILL.md file:
    .claude/skills/<skill-name>/SKILL.md
  Local skills always take precedence over MCP-delivered skills.
  Override paths checked:
    ~/.claude/skills/          (user-global)
    .claude/skills/            (project-local)
```

**In the Foreman MCP README (shipped with the bundle):**
```markdown
## Customizing Workflow Prompts

Foreman delivers its planner and implementor skills via MCP. If you need to
customize the workflow for your project:

1. Run the skill once to see its name (e.g., `foreman:implementor`)
2. Create `.claude/skills/foreman-implementor/SKILL.md` in your project
3. Copy the original skill body and modify as needed
4. Your local version takes precedence automatically

To revert: delete the local SKILL.md file.
```

**In each skill's own prompt body (first line after frontmatter):**
```
Note: This skill is delivered by the Foreman MCP bundle. To customize it,
create a local override at .claude/skills/<this-skill-name>/SKILL.md
```

### Error Handling

| Scenario | Action |
|----------|--------|
| Local override has syntax errors in frontmatter | Claude Code's existing skill loader reports parse errors. MCP version is NOT used as fallback — the local override is authoritative even if broken. This is existing behavior. |
| Local override has different version than MCP | No conflict. Local version is used regardless. `bundle_status` reports MCP version; local version is tracked by its own frontmatter. |

---

## Change 6: Ledger as Single Authority (Prevent Split-Brain)

### Problem

Claude Code persists plan state under `~/.claude/plans/` (with resume recovery via `plan_file_reference` across compaction — `compact.ts:1470`) and task state under `~/.claude/tasks/` (`tasks.ts:221`). The Foreman design creates a SECOND state store in `Docs/.foreman-ledger.json` + `Docs/PROGRESS.md`. On resume, branch switch, or multi-session work, these stores can disagree on "what phase are we in?"

Source: Codex (GPT-5.4) Architecture Council finding #1 — verified against `src/utils/plans.ts:79,164` and `src/utils/tasks.ts:221`.

### Solution

The Foreman ledger is the **single workflow authority**. Host plan/task state is ephemeral — rebuilt from the ledger at the start of each session.

### State Authority Model

| State | Authority | Lifetime |
|-------|-----------|----------|
| Workflow phases, verdicts, rejections, phase gates | Ledger (`Docs/.foreman-ledger.json`) | Durable across sessions |
| Current unit progress, worker assignments | Ledger | Durable |
| Claude Code plan file (`~/.claude/plans/`) | Host runtime | Ephemeral — rebuilt per session |
| Claude Code task list (`~/.claude/tasks/`) | Host runtime | Ephemeral — rebuilt per session |
| Human-readable progress | `Docs/PROGRESS.md` | Rendered view, not authoritative |

### Resume Protocol

On every Foreman skill invocation:

1. Read the ledger via `mcp__foreman__read_ledger`.
2. Determine current phase and next unit from ledger state.
3. Create/update Claude Code tasks (`TaskCreate`/`TaskUpdate`) to reflect ledger state.
4. If a host plan file exists from a previous session, ignore it — the ledger is authoritative.
5. Proceed from the ledger's current position.

### Reconciliation Rule

- **Ledger vs host state:** Ledger always wins. Host state is a projection.
- **Ledger vs disk files (code):** Disk wins for code state (what's been implemented). Ledger wins for workflow state (what's been approved/rejected).
- **Manual ledger edits:** Accepted. The ledger is a JSON file in the repo — users can edit it. The skill reads whatever is on disk.

### Implementation Directives

- Each skill body (planner, implementor) must include a **Session Start Protocol** section:
  ```
  SESSION START:
  1. Call mcp__foreman__read_ledger with query "full"
  2. Call mcp__foreman__read_progress
  3. Rebuild your understanding of current state from these results
  4. Do NOT rely on Claude Code's plan file or task list from prior sessions
  5. Create fresh tasks for current phase work items
  ```
- The `mcp__foreman__read_progress` tool output includes a `session_hint` field: the next action the skill should take, derived from ledger state.

### Error Handling

| Scenario | Action |
|----------|--------|
| Ledger missing on resume | First run. Create ledger, start from beginning. |
| Ledger says Phase 2 complete but code doesn't reflect it | Code wins for code state. Skill should verify unit outputs before advancing. Ledger's verdict stands but implementation may need re-work. |
| Host tasks exist from prior session | Ignore. Create fresh tasks from ledger state. |

---

## Change 7: Canonical Invocation Surface Per Skill

### Problem

Claude Code has two materially different execution paths for skills:

1. **Slash-command** (`/foreman-plan`): Loads skill content into the main thread. Attaches `command_permissions` which are cleared on the next non-skill turn (`REPL.tsx:2701`). Permissions don't survive compaction (`compact.ts:1470,1530`).

2. **SkillTool** (model-invoked): Runs the skill in a forked agent with modified app state (`SkillTool.ts:122`, `forkedAgent.ts:147`). Gets its own context isolation.

The same skill can behave differently depending on invocation path. Compaction can strip capabilities that the implementor needs for multi-turn work.

Source: Codex (GPT-5.4) Architecture Council finding #4 — verified against `src/utils/processUserInput/processSlashCommand.tsx:827`, `src/tools/SkillTool/SkillTool.ts:122`, `src/services/compact/compact.ts:1470`.

### Solution

Define one canonical invocation surface per skill. Do not assume slash-command and SkillTool semantics are interchangeable.

| Skill | Canonical Surface | Reason |
|-------|-------------------|--------|
| `foreman:project-planner` | Either (slash-command or SkillTool) | Single-turn planning doesn't need forked context. Permissions survive the turn. |
| `foreman:implementor` | **SkillTool only** | Multi-turn implementation needs forked agent context. Permissions must survive across turns and compaction. |

### Implementation Directives

- The implementor skill's frontmatter must include `disableSlashCommand: true` (or equivalent) to prevent slash-command invocation.
- If `disableSlashCommand` is not available as frontmatter, the implementor skill body must detect its invocation context and refuse to run if invoked as a slash-command:
  ```
  If you are running as a slash command (not via SkillTool), STOP.
  Tell the user: "The Foreman implementor must be invoked via SkillTool,
  not as a slash command. Use: 'run the foreman:implementor skill' instead
  of '/foreman-implementor'."
  ```
- The planner skill can be invoked either way — no restriction needed.

### Error Handling

| Scenario | Action |
|----------|--------|
| User types `/foreman-implementor` | Skill detects slash-command context and refuses with guidance. |
| Model invokes implementor via SkillTool | Normal operation — forked agent context, correct permissions. |
| Compaction during implementor run | Forked agent context preserved. Skill re-reads ledger on resume per Change 6. |

---

## File Structure

```
foreman-mcp/                          # MCP server package
├── src/
│   ├── server.ts                     # MCP server setup (stdio transport)
│   ├── tools/
│   │   ├── bundleStatus.ts           # bundle_status tool
│   │   ├── changelog.ts              # changelog tool
│   │   ├── writeLedger.ts            # write_ledger tool (with mutex)
│   │   ├── readLedger.ts             # read_ledger tool
│   │   ├── readProgress.ts           # read_progress tool (truncation)
│   │   ├── writeProgress.ts          # write_progress tool
│   │   ├── capabilityCheck.ts        # capability_check tool
│   │   └── normalizeReview.ts        # normalize_review tool
│   ├── skills/
│   │   ├── project-planner.md        # MCP skill body
│   │   └── implementor.md            # MCP skill body
│   ├── lib/
│   │   ├── ledger.ts                 # Ledger read/write with mutex
│   │   ├── progress.ts               # Progress read/write with truncation
│   │   ├── externalCli.ts            # External CLI runner with timeout
│   │   └── toon.ts                   # TOON format serializer
│   └── types.ts                      # Shared types (LedgerFile, ProgressFile, etc.)
├── tests/
│   ├── ledger.test.ts                # Mutex serialization, corruption recovery
│   ├── progress.test.ts              # Truncation algorithm, bounded output
│   ├── externalCli.test.ts           # Timeout, stdin redirect, fallback
│   └── integration.test.ts           # MCP tool round-trip, skill discovery
├── package.json
├── tsconfig.json
└── README.md                         # Includes skill override documentation
```

---

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.12.0"
}
```

Dev dependencies:
```json
{
  "vitest": "^3.2.0",
  "typescript": "^5.8.0",
  "@types/node": "^22.0.0"
}
```

Note: No `proper-lockfile` needed — the primary serialization mechanism is the in-process async mutex (MCP server is single-process). Native `JSON.parse`/`JSON.stringify` for ledger — zero additional dependencies for data serialization.

---

## Out of Scope

- Full planner workflow implementation (governed by design summary)
- Full implementor workflow implementation (governed by design summary)
- Team debate protocol (governed by design summary)
- MCP skill body content (planner/implementor prompts — separate authoring task)
- Plugin bootstrap/installer UX
- Codex adapter
- `mcpSkills.ts` implementation (missing from Claude Code source — separate issue, tracked in design summary open items)

---

## Testing Strategy

### Archetype: Infrastructure Tool (MCP Server)

### What to Test

| Category | Scope | Mock/Real |
|----------|-------|-----------|
| Ledger mutex serialization | Concurrent write_ledger calls don't corrupt state | Real filesystem, concurrent async calls |
| Ledger corruption recovery | Malformed JSON triggers backup + fresh create | Real filesystem with injected bad JSON |
| Progress truncation | Output bounded to last N + incomplete | Unit test, no filesystem |
| External CLI timeout | Process killed after timeout, partial output captured | Mock child_process spawn |
| External CLI stdin | No interactive prompts (stdin closed) | Mock child_process spawn |
| Capability check | Detects missing CLI, expired auth, working CLI | Mock child_process spawn |
| MCP tool round-trip | Tool call → server handler → response | Real MCP SDK test client |
| Skill override precedence | Local SKILL.md overrides MCP skill | Integration test with SkillTool |
| Bundle status output | Reports version, compatibility, override info | Unit test |

### What NOT to Test

- Claude Code's internal MCP client reconnection logic (already tested upstream)
- `proper-lockfile` behavior (third-party, well-tested)
- Actual Codex/Gemini CLI output quality (opaque external systems)

### Mock Boundaries

| Dependency | Mock Strategy |
|------------|---------------|
| Filesystem (ledger/progress) | Real filesystem in temp directory (vitest `tmpdir`) |
| External CLIs (codex/gemini) | Mock `child_process.spawn` — test timeout, exit codes, stdout |
| MCP SDK | Real SDK test client for round-trip; mock for unit tests |

### Critical Path (High Coverage)

- `src/lib/ledger.ts` — 90% — mutex correctness, corruption recovery, concurrent writes
- `src/lib/externalCli.ts` — 90% — timeout behavior, stdin handling, error modes
- `src/lib/progress.ts` — 80% — truncation algorithm, edge cases (empty, single unit, overflow)

### Coverage Targets

| Package | Target | Focus |
|---------|--------|-------|
| `src/lib/` | 90% | error paths, concurrency, edge cases |
| `src/tools/` | 70% | input validation, output format |
| `src/server.ts` | 50% | startup, tool registration |

---

## Implementation Order

### Phase 1: Foundation (Types, Ledger, Progress)

**Unit 1a: Types and ledger core**
1. `src/types.ts` — LedgerFile, ProgressFile, TruncatedView, ToolInput/Output types
   - Implementation directives:
     - Use discriminated unions for operation types
     - Export Zod schemas for MCP tool input validation
     - DO NOT use `any` types; all payloads must be typed
2. `src/lib/ledger.ts` — Ledger read/write with async mutex
   - Implementation directives:
     - Mutex: promise-chain pattern (see spec above), NOT `proper-lockfile` (overkill for single process)
     - Read: `readFile` → `JSON.parse` with try/catch for corruption
     - Write: `JSON.stringify(data)` (no pretty-print — token savings) → write to `.tmp` → `rename` (atomic)
     - Corruption recovery: rename corrupt file with timestamp, create fresh
     - DO NOT use `writeFileSync` — all IO must be async
3. `tests/ledger.test.ts` — Mutex serialization, corruption recovery
   - Test: 10 concurrent `writeLedger` calls all succeed without data loss
   - Test: corrupt JSON file triggers recovery, fresh ledger created
   - Test: missing ledger file auto-created on first write
   ```bash
   npx vitest run tests/ledger.test.ts
   ```

**Unit 1b: Progress core with truncation**
1. `src/lib/progress.ts` — Progress read/write with truncation
   - Implementation directives:
     - Truncation: sort completed units by `completed_at` desc, take last N, include ALL incomplete
     - Write: same mutex pattern as ledger (separate mutex instance)
     - Format: return structured object, not raw markdown
     - DO NOT read/parse the existing markdown PROGRESS.md — the MCP server maintains its own compact JSON progress state; the markdown file is generated FROM it for human reading
2. `tests/progress.test.ts` — Truncation algorithm
   - Test: 50 completed + 5 incomplete → output has 10 completed + 5 incomplete
   - Test: 0 completed → output has only incomplete
   - Test: error log truncated to last 5
   ```bash
   npx vitest run tests/progress.test.ts
   ```

**CHECKPOINT:**
```bash
npx vitest run tests/ledger.test.ts tests/progress.test.ts
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

### Phase 2: External CLI Runner

**Unit 2a: External CLI execution with timeout**
1. `src/lib/externalCli.ts` — Spawn external process with timeout + stdin redirect
   - Implementation directives:
     - Use `child_process.spawn` (NOT `exec` — need stream control)
     - Close stdin immediately after spawn (`child.stdin.end()`)
     - Kill with `SIGTERM` on timeout, then `SIGKILL` after 5s grace
     - Capture stdout and stderr separately
     - Return `{ stdout, stderr, timedOut, exitCode }`
     - DO NOT use shell mode (`shell: true`) — direct exec to avoid shell injection
2. `tests/externalCli.test.ts` — Timeout, stdin, error modes
   - Test: process completing before timeout returns full output
   - Test: process exceeding timeout is killed, partial output returned, `timedOut: true`
   - Test: missing binary returns `ENOENT` error gracefully
   - Test: stdin is closed (use a test script that reads stdin and fails if data arrives)
   ```bash
   npx vitest run tests/externalCli.test.ts
   ```

**CHECKPOINT:**
```bash
npx vitest run tests/
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

### Phase 3: MCP Tools

**Unit 3a: Read-only tools (bundle_status, changelog, read_ledger, read_progress, capability_check)**
1. `src/tools/bundleStatus.ts` — Version check + override info
   - Implementation directives:
     - Read package.json version for bundle version
     - Read skill frontmatter for per-skill versions
     - Include OVERRIDE INFO section in output (see Change 5 spec)
     - Output: TOON key/value format
2. `src/tools/changelog.ts` — Version changelog
   - Keep a static changelog array in the module; filter by `since_version`
   - Output: TOON table
3. `src/tools/readLedger.ts` — Ledger query
   - Delegate to `lib/ledger.ts` read function
   - Apply query filter (unit, phase, or full)
   - Output: TOON table for lists, key/value for single items
4. `src/tools/readProgress.ts` — Truncated progress view
   - Delegate to `lib/progress.ts` truncation function
   - Output: structured TOON (see Change 4 spec)
5. `src/tools/capabilityCheck.ts` — External CLI detection
   - Run health check via `lib/externalCli.ts` with 15s timeout
   - Return availability, version (parse from `--version`), auth status
6. `src/lib/toon.ts` — TOON format serializer
   - `toKeyValue(record)` → `key: value\n` lines
   - `toTable(headers, rows)` → column-aligned pipe-delimited table
   - DO NOT over-engineer — two functions, no classes

**Unit 3b: Write tools (write_ledger, write_progress)**
1. `src/tools/writeLedger.ts` — Serialized ledger mutations
   - Validate input with Zod schema
   - Delegate to `lib/ledger.ts` write function
   - Return confirmation with updated state
2. `src/tools/writeProgress.ts` — Progress updates
   - Validate input with Zod schema
   - Delegate to `lib/progress.ts` write function
   - After JSON write, regenerate `Docs/PROGRESS.md` markdown from JSON state
3. `src/tools/normalizeReview.ts` — Review result ingestion
   - Accept raw review output (string) + reviewer name
   - Parse into structured findings (severity, file, line, description)
   - Return normalized structure for ledger recording

**CHECKPOINT:**
```bash
npx vitest run tests/
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

### Phase 4: MCP Server Wiring

**Unit 4a: Server setup and skill delivery**
1. `src/server.ts` — MCP server with all tools registered
   - Implementation directives:
     - Use `@modelcontextprotocol/sdk` Server class
     - Register all tools via `ListToolsRequestSchema` handler
     - Register all resources via `ListResourcesRequestSchema` handler (for skill:// delivery)
     - Serve skill bodies from `src/skills/*.md` as `skill://foreman/<name>` resources
     - Handle `resources/list_changed` notification for skill updates
     - Transport: stdio (default), configurable
     - DO NOT expose `update_bundle` as a tool
2. `src/skills/project-planner.md` — Planner skill body (stub with frontmatter)
   - Include version in frontmatter
   - Include ledger-write prohibition directive
   - Include local override notice
3. `src/skills/implementor.md` — Implementor skill body (stub with frontmatter)
   - Same directives as planner
4. `tests/integration.test.ts` — MCP round-trip test
   - Test: connect test client → list tools → call bundle_status → verify response
   - Test: connect test client → list resources → verify skill:// URIs present
   - Test: call write_ledger → call read_ledger → verify state persisted
   ```bash
   npx vitest run tests/integration.test.ts
   ```

**FINAL:**
```bash
npx vitest run
```
**-> Deliver to user. Implementation complete.**

---

## Progress Tracking

### Session Protocol

**On every new session:**
1. Read `Docs/foreman/PROGRESS.md` for current state
2. Scan existing files in `foreman-mcp/` to verify progress
3. Run `npx vitest run` to check test status
4. Resume from next incomplete item

### New Chat Policy

Start a fresh chat after each CHECKPOINT passes.
