# v0.0.5 Spec — Bounded Test Output + Security Hardening

## Intent

Add output truncation to Foreman's test execution and external CLI paths so that verbose test output (stack traces, linter noise) cannot blow out the LLM context window or confuse the pitboss validation layer. Introduces a new `run_tests` MCP tool that the pitboss uses instead of raw Bash, and caps the existing `externalCli` buffers.

Also addresses 5 security findings from the Purple Team pentest triage (see `Docs/.triage-ledger.yaml`): structured runner/args input for `run_tests` (no shell), tiered input length caps on write schemas, absolute path resolution for external CLIs, generic skill loader errors, and rejection array cap. ESC-001 (no MCP auth) accepted as risk after arch council review.

## Decisions & Notes

| Decision | Choice | Rationale | Source |
|----------|--------|-----------|--------|
| Truncation strategy | Keep tail, discard head | Test failures and linter errors appear at the end of output; passing tests scroll by at the top | Design discussion |
| Default max output for `run_tests` | 8000 chars | Enough for ~3 full stack traces; small enough to not bloat context | Design discussion |
| Default max output for `externalCli` | 16000 chars | Review output is higher-value than test noise; needs more room | Design discussion |
| Default timeout for `run_tests` | 60000ms (60s) | Matches typical test suite duration; consistent with externalCli pattern | Existing pattern in capabilityCheck.ts (15s health, 300s deliberation) |
| `passed` field derivation | `exit_code === 0` | Standard POSIX convention; no JSON reporter parsing needed | Design discussion — keep simple |
| Execution model | `spawn(runner, args)` — NO shell | Runner must be in allowlist; args passed as array, no shell metacharacter risk | INJ-003 + arch council review — `sh -c` with prefix check is bypassable via `;`, `&&`, `\|` |
| Runner allowlist | `npm`, `npx`, `pytest`, `go`, `cargo`, `dotnet`, `make` | Known test runner binaries only. No interpreters (`node`, `ruby`, `python`) — those are arbitrary code exec. Extensible via `FOREMAN_TEST_ALLOWLIST` env var (comma-separated binary names). | INJ-003 remediation + arch council: `node -e` and `ruby -e` are RCE |
| String field caps | Tiered: `.max(50000)` for `brief` (trusted, contains code excerpts), `.max(10000)` for all other fields | Prevents memory exhaustion without breaking pitboss worker briefs | INJ-004, EXH-002 + arch council: 10K cap on brief breaks pitboss workflow |
| Rejection array cap | 20 entries FIFO per unit | Prevents unbounded ledger growth; oldest rejections discarded | EXH-002 pentest finding |
| CLI path resolution | Resolve `codex`/`gemini` to absolute paths at startup | Prevents PATH poisoning | INJ-005 pentest finding |
| Skill loader errors | Generic message to MCP client, full paths to stderr only | Prevents filesystem path disclosure | DIS-001 pentest finding |
| Truncation marker | `...(truncated)\n` | Simple, unambiguous, won't confuse LLM pattern matching | Convention |

## Architecture

No new files beyond the tool handler. Fits into existing structure:

```
foreman-mcp/src/
├── lib/
│   ├── externalCli.ts          ← MODIFY: add MAX_OUTPUT cap to buffers
│   ├── ledger.ts               ← MODIFY: cap rej[] at 20 entries FIFO
│   ├── progress.ts             ← (no change — caps come from write schema)
│   └── skillLoader.ts          ← MODIFY: generic error message, full paths to stderr
├── tools/
│   ├── runTests.ts             ← CREATE: new tool handler with command allowlist
│   ├── capabilityCheck.ts      ← MODIFY: resolve CLI paths to absolute at startup
│   └── writeLedger.ts          ← (no change — caps come from types.ts schema)
├── types.ts                    ← MODIFY: add .max() to all string fields in write schemas
├── server.ts                   ← MODIFY: register run_tests tool, bump version
├── skills/
│   └── implementor.md          ← MODIFY: update step 6.2 to use run_tests
└── tools/
    └── changelog.ts            ← MODIFY: add 0.0.5 entry
```

## Config Schema

No new configuration. The `run_tests` tool accepts per-call parameters:

```typescript
{
  runner: z.string().min(1),                    // required — binary name, must be in allowlist
  args: z.array(z.string()).default([]),        // arguments passed to the runner (no shell interpretation)
  timeout_ms: z.number().max(600000).optional(),      // default 60000, hard cap 10 min
  max_output_chars: z.number().max(50000).optional(), // default 8000, hard cap 50K
}
```

**Runner allowlist (enforced before spawn):**
```typescript
const DEFAULT_ALLOWED_RUNNERS = [
  "npm", "npx", "pytest", "go", "cargo", "dotnet", "make",
]
// Extensible via FOREMAN_TEST_ALLOWLIST env var (comma-separated binary names)
// NO interpreters (node, ruby, python) — those are arbitrary code execution
```

Runners not in the allowlist are rejected *before* spawning:
```
error: runner not in allowlist
runner: <the rejected runner>
allowed_runners: npm, npx, pytest, go, cargo, dotnet, make
```

**Execution:** `spawn(runner, args)` — no shell. Args are passed as an array directly to the child process. Shell metacharacters (`;`, `&&`, `|`, `$()`, backticks) have no effect because there is no shell to interpret them.

## Core Behavior

1. LLM calls `mcp__foreman__run_tests({ runner: "npm", args: ["test"] })`
2. Tool validates `runner` is in the allowlist. If not, returns error without spawning.
3. Tool spawns `spawn(runner, args)` via `child_process.spawn` — NO shell.
4. stdout and stderr are collected independently. After process exits, each is capped at `max_output_chars` — truncation happens once at the end, not on every `data` event (avoids O(N^2) slicing).
5. On process exit or timeout, tool returns TOON key/value output:
   ```
   exit_code: 1
   passed: false
   timed_out: false
   truncated: true
   
   STDOUT
   ...(truncated)
   <last 8000 chars of stdout>

   STDERR
   <last 8000 chars of stderr>
   ```
6. Pitboss reads `passed` for verdict, `exit_code` for diagnostics, STDERR tail for failure context

## Error Handling

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Runner not in allowlist | TOON error response, no process spawned | Pitboss reports rejected runner to user |
| Runner binary not found (ENOENT) | `exit_code: -1`, `passed: false`, stderr contains ENOENT | Pitboss reports command failure to user |
| Timeout | `timed_out: true`, `exit_code: -1`, `passed: false`, partial stdout/stderr returned | Pitboss rejects unit, logs timeout in ledger |
| Empty runner string | Zod validation rejects (`.min(1)`) | MCP returns validation error before execution |
| timeout_ms > 600000 | Zod validation rejects (`.max(600000)`) | MCP returns validation error |
| max_output_chars > 50000 | Zod validation rejects (`.max(50000)`) | MCP returns validation error |
| Very large output (>max_output_chars) | Truncated with marker, `truncated: true` | Normal — this is the point of the tool |
| Process crash/signal | Non-zero exit code captured | Same as test failure |

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `child_process` | Node.js built-in | Process spawning (already used by externalCli.ts) |
| `zod` | ^3.24.0 | Input validation (already a dependency) |

No new dependencies.

## Out of Scope

- JSON test reporter detection or parsing
- Structured pass/fail count extraction from output
- Changes to design_partner or spec_generator skills
- Streaming output to the LLM during execution
- OS-level file locking changes
- Token counting or budget enforcement
- MCP authentication (accepted risk — ESC-001, small stdio attack surface, ZTNA + EDR covers threat model)
- Ledger schema validation on read (accepted risk — INJ-002)
- Read-path escaping for stored prompt injection (INJ-004 partially mitigated by length caps; full fix via output escaping/quoting deferred to v0.0.6)

## Testing Strategy

**Archetype:** Unit tests with real child_process spawns (same pattern as existing `externalCli.test.ts`)

| What to test | How |
|-------------|-----|
| Normal test pass | `runTests("npm", ["test"])` on a passing project, verify `passed: true`, `exit_code: 0` |
| Normal test fail | `runTests("npx", ["vitest", "run", "--reporter=verbose"])` on failing test, verify `passed: false` |
| Output truncation (stdout) | Spawn process producing >8000 chars, verify output is capped and `truncated: true` |
| Output truncation (stderr) | Same for stderr |
| Truncation keeps tail | Write known marker at end of large output, verify it's preserved after truncation |
| Truncation marker present | Verify `...(truncated)\n` prefix when truncated |
| Truncation happens once | Verify truncation runs after process exit, not on every data event |
| Timeout handling | Runner that hangs, short timeout, verify `timed_out: true` |
| Custom timeout_ms | Override default, verify shorter timeout triggers |
| Custom max_output_chars | Override default, verify truncation at custom limit |
| Hard cap: timeout_ms > 600000 | Verify Zod rejects it |
| Hard cap: max_output_chars > 50000 | Verify Zod rejects it |
| externalCli buffer cap | Spawn large-output process via externalCli, verify truncation at 16000 |
| externalCli preserves existing behavior | Existing tests still pass (normal, timeout, ENOENT, stdin close, exit code, stderr separation) |
| **Security: runner allowlist** | `runTests("npm", ["test"])` passes; `runTests("curl", ["evil.com"])` rejected without spawning |
| **Security: shell metachar bypass blocked** | `runTests("npm", ["test;", "rm", "-rf", "/"])` — args are array, no shell, semicolon is literal arg |
| **Security: no interpreters** | `runTests("node", ["-e", "..."])` rejected — `node` not in default allowlist |
| **Security: custom allowlist via env** | Set `FOREMAN_TEST_ALLOWLIST=custom_runner`, verify `runTests("custom_runner", ["foo"])` is allowed |
| **Security: brief field cap (50K)** | Call `write_ledger` with `brief` of 50001 chars → Zod rejects. 49999 chars → passes. |
| **Security: msg field cap (10K)** | Call `write_ledger` with `msg` of 10001 chars → Zod rejects |
| **Security: rejection array cap** | Add 25 rejections to one unit, verify only last 20 are retained |
| **Security: generic skill loader error** | Trigger skill-not-found, verify error message does NOT contain absolute paths |
| **Security: CLI path resolution** | Verify `capabilityCheck` resolves to absolute path (or returns unavailable if `which` fails) |

**What NOT to test:**
- Actual npm/vitest output parsing (we're testing the harness, not the test framework)
- MCP protocol integration (covered by existing integration.test.ts pattern)

## Implementation Order

### Phase 1: Core Infrastructure (2 units)

**Unit 1a — `externalCli` buffer cap**
- Files: `foreman-mcp/src/lib/externalCli.ts`
- Directive: Add `MAX_OUTPUT` constant (16000). In both stdout and stderr `data` handlers, after appending chunk, if buffer length exceeds `MAX_OUTPUT`, slice to keep tail and prepend truncation marker. Export `MAX_OUTPUT` for test access. Add `truncated` field to `ExternalCliResult` interface — set `true` if either buffer was truncated.
- Test command: `cd foreman-mcp && npx vitest run tests/externalCli.test.ts`
- DO NOT: Change the function signature, timeout logic, or process spawning behavior

**Unit 1b — `runTests` tool handler**
- Files: `foreman-mcp/src/tools/runTests.ts` (CREATE)
- Directive: Create `runTests(runner: string, args: string[], timeoutMs?: number, maxOutputChars?: number): Promise<string>`. Default timeout 60000, default max output 8000. **Before spawning, validate `runner` against `DEFAULT_ALLOWED_RUNNERS`** (also check `FOREMAN_TEST_ALLOWLIST` env var, comma-separated). If not allowed, return a TOON error response without spawning. If allowed, spawn via `spawn(runner, args)` — **NO SHELL**. Collect stdout/stderr into buffers. **Truncate once after process exits** (not on every `data` event): if buffer length > maxOutputChars, slice to keep tail and prepend `"...(truncated)\n"`. Close stdin immediately. Timeout with SIGTERM then SIGKILL (same pattern as externalCli). Return TOON key/value string with fields: `exit_code`, `passed` (exit_code === 0), `timed_out`, `truncated`, then `\nSTDOUT\n<stdout>\n\nSTDERR\n<stderr>`. Export `DEFAULT_ALLOWED_RUNNERS` for test access.
- Test command: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`
- DO NOT: Import or depend on externalCli.ts — duplicate the spawn pattern to keep them independent. Do not add JSON parsing. Do NOT use `shell: true` or `sh -c`.

**Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 2: Integration & Protocol (2 units)

**Unit 2a — Register tool in server.ts + version bump**
- Files: `foreman-mcp/src/server.ts`, `foreman-mcp/package.json`, `foreman-mcp/src/tools/changelog.ts`
- Directive: Import `runTests` from `./tools/runTests.js`. Register `run_tests` tool with Zod schema: `runner: z.string().min(1)`, `args: z.array(z.string()).default([])`, `timeout_ms: z.number().max(600000).optional()`, `max_output_chars: z.number().max(50000).optional()`. Description: `"Runs a test command with bounded output. Runner must be in allowlist (npm, npx, pytest, go, cargo, dotnet, make). Use instead of Bash for test execution."`. Bump version to `"0.0.5"` in both `package.json` and `server.ts` McpServer constructor. Add changelog entry for 0.0.5.
- Test command: `cd foreman-mcp && npx vitest run tests/tools.test.ts`
- DO NOT: Change any existing tool registrations. Do not modify tool descriptions for existing tools.

**Unit 2b — Update implementor.md protocol**
- Files: `foreman-mcp/src/skills/implementor.md`
- Directive: In Step 6 (Validate), replace item 2 from `"**Re-run tests** — execute the test command yourself; do not accept worker's 'tests pass' claim"` to `"**Re-run tests** — call mcp__foreman__run_tests with the unit's test command; read exit_code for pass/fail, STDERR tail for failure context. Do not run tests via Bash — raw output can overflow context."`. In the Checkpoint Protocol section 1 (Full Test Suite), add the same guidance: `"Run via mcp__foreman__run_tests, not Bash."`. Update the skill version frontmatter from 0.0.4 to 0.0.5.
- Test command: `cd foreman-mcp && npx vitest run tests/skillLoader.test.ts`
- DO NOT: Change any other section of implementor.md. Do not modify gates G1-G5, fix protocol, or checkpoint deliberation flow.

**Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 3: Security Hardening (4 units)

From pentest triage — see `Docs/.triage-ledger.yaml` for finding details.

**Unit 3a — Tiered input length caps on write schemas**
- Files: `foreman-mcp/src/types.ts`
- Directive: Apply tiered `.max()` caps to all `z.string()` fields in `WriteLedgerInputSchema` and `WriteProgressInputSchema`:
  - **Trusted fields (50K):** `brief` — set by pitboss, contains code excerpts. Use `.max(50000)`.
  - **Untrusted fields (10K):** `msg`, `r`, `ts`, `unit_id`, `phase`, `notes`, `what_failed`, `next_approach`, `name`, `status`, `date`, `unit`, `completed_at`. Use `.max(10000)`.
  - This mitigates memory exhaustion (EXH-002) via unbounded string fields. Note: this does NOT fully fix stored prompt injection (INJ-004) — length caps prevent exhaustion but injected instructions under the limit still flow unescaped to LLM context. Full INJ-004 fix (read-path escaping) deferred to v0.0.6.
- Test command: `cd foreman-mcp && npx vitest run tests/writeTools.test.ts`
- DO NOT: Change the field names, types, or structure. Only add `.max()` constraints.

**Unit 3b — Rejection array cap + generic skill loader error**
- Files: `foreman-mcp/src/lib/ledger.ts`, `foreman-mcp/src/lib/skillLoader.ts`
- Directive (ledger.ts): In the `add_rejection` case of `applyOperation`, after pushing to `rej[]`, if `rej.length > 20`, slice to keep the last 20: `unit.rej = unit.rej.slice(-20)`. This caps growth at 20 rejections per unit (EXH-002).
- Directive (skillLoader.ts): Replace the error at lines 41-46 with a generic message: `throw new Error(\`Skill "${skillName}" not found. Check .claude/skills/ overrides or reinstall the package.\`)`. Log the full paths to stderr: `console.error(\`Skill "${skillName}" lookup paths: project=${projectOverride}, user=${userOverride}, bundled=${bundled}\`)`. This prevents path disclosure (DIS-001).
- Test command: `cd foreman-mcp && npx vitest run tests/ledger.test.ts tests/skillLoader.test.ts`
- DO NOT: Change the skill loading priority order. Do not change the rej[] data structure.

**Unit 3c — Absolute path resolution for external CLIs**
- Files: `foreman-mcp/src/tools/capabilityCheck.ts`
- Directive: At the top of `capabilityCheck()`, resolve the bare command name to an absolute path using `which` (spawn `which codex` or `which gemini` via runExternalCli with 3s timeout). If `which` returns exit 0, use the resolved absolute path for all subsequent spawn calls. If `which` fails (command not found), return `available: false` immediately without running the health check. Cache the resolved path in a module-level `Map<string, string>` so `which` only runs once per CLI per process lifetime. This prevents PATH poisoning (INJ-005).
- Test command: `cd foreman-mcp && npx vitest run tests/tools.test.ts`
- DO NOT: Change the health check logic, timeout handling, or TOON output format.

**Unit 3d — Update changelog description**
- Files: `foreman-mcp/src/tools/changelog.ts`
- Directive: Update the v0.0.5 changelog entry description to include security items: `"run_tests tool — bounded test output with command allowlist; externalCli buffer cap; security hardening: input length caps, rejection array cap, absolute CLI path resolution, generic skill loader errors (pentest triage v0.0.5)"`.
- Test command: `cd foreman-mcp && npx vitest run tests/tools.test.ts`
- DO NOT: Change any other changelog entries.

**Checkpoint:** `cd foreman-mcp && npx vitest run`
